import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineAgent } from "@/ai/agents/types";
import { runAgent } from "@/ai/orchestrator";
import { getTrip, getTripDestinations } from "@/modules/trip/trip-service";
import {
  calendarDayOf,
  replaceGeneratedPlan,
  type PlanItemDraft,
} from "@/modules/itinerary/itinerary-service";
import { itineraryDaySchema, itineraryTimeSchema } from "@/modules/itinerary/validation";
import { ITINERARY_ITEM_TYPES } from "@/modules/itinerary/itinerary-repository";
import type { ItineraryBudgetStatus } from "@/modules/itinerary/budget-service";
import type { DestinationRecord, TripRecord } from "@/modules/trip/trip-service";
import { providerAvailability } from "@/config/env";
import { generateRequestId } from "@/shared/api-response";
import { ProviderError, ValidationError } from "@/shared/errors";

/**
 * Planning Agent — Phase 20, the seventh and last specialized agent the
 * brief names (Flight / Weather / Currency / Research / Document / Risk /
 * Planning).
 *
 * Unlike the Flight, Weather, and Currency agents, this belongs in Phase
 * 9's LLM orchestrator: composing a day-by-day schedule from real trip
 * data, weather, search results, and uploaded documents is a synthesis
 * task with no deterministic formula behind it. The Risk Agent is the
 * closest precedent — deterministic engine underneath, model on top — and
 * this file follows its discipline:
 *
 *  - The model writes the *schedule* (which activities, where, when), and
 *    nothing else. It has no access to any write tool: the orchestrator's
 *    only side effect is `callTool`, and its allowed tools are all reads.
 *  - Its output has **no cost fields at all**, so a model-generated price
 *    cannot reach the database even accidentally. Cost data is the
 *    traveler's own input, validated deterministically in
 *    modules/itinerary/budget-service.ts.
 *  - Every day and every city in a generated plan is checked in code
 *    against the trip's stored dates and destinations before anything is
 *    persisted. A fabricated city or an out-of-range date fails the whole
 *    run with a specific error rather than being saved and displayed as
 *    if real.
 *
 * Persistence happens *after* that grounding check, in the service, not
 * by the model calling a save tool in the middle of reasoning.
 */

export const planItemSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("What the traveler does, e.g. 'Lunch at Shiro'. "),
  itemType: z.enum(ITINERARY_ITEM_TYPES).describe("The kind of item this is."),
  startTime: itineraryTimeSchema.describe("24-hour local time, HH:MM."),
  endTime: itineraryTimeSchema
    .optional()
    .describe("24-hour local time, or omit if the item has no clear end."),
  destinationCity: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "One of the trip's destination cities, exactly as listed in the request. Never a city that is not on that list.",
    ),
  location: z
    .string()
    .trim()
    .max(300)
    .optional()
    .describe("A specific named place in that city, only if it came from a real source."),
  notes: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .describe("Practical context from retrieved information (hours, booking reference, weather)."),
});

export const planDaySchema = z.object({
  date: itineraryDaySchema.describe("YYYY-MM-DD. Must fall within the trip's dates."),
  items: z
    .array(planItemSchema)
    .min(1)
    .max(12)
    .describe("The day's schedule, in chronological order."),
});

export const planningOutputSchema = z.object({
  days: z.array(planDaySchema).min(1).describe("One entry per day of the trip you plan."),
  rationale: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("Why the plan is shaped this way, referencing the real data used."),
  assumptions: z
    .array(z.string().trim().min(1).max(500))
    .max(20)
    .describe("Anything you had to assume because no stored or retrieved data covered it."),
});

export type PlanningOutput = z.infer<typeof planningOutputSchema>;

export const planningAgent = defineAgent({
  name: "planning_agent",
  role: `You are an itinerary planner for a real trip. You compose a day-by-day schedule from the traveler's actual trip data and from information you retrieve with tools.

Rules, no exceptions:
- Ground every item in retrieved data. Use get_trip / get_trip_itinerary / get_weather / search_destination / search_trip_knowledge to learn what is actually true about this trip before scheduling. Never schedule from your own memory of a city.
- Every date in your plan must fall inside the trip's dates given in the request, and every destinationCity value must exactly match one of the trip's destination cities listed there. Anything else fails validation and the plan is discarded.
- Never state, estimate, or invent a price, fare, fee, or cost, and never include a monetary figure in any title or note. The traveler enters costs themselves; only they and their documents know what things cost. If a retrieved source states an actual price, you may mention it in notes and attribute it, but never guess one.
- Do not duplicate items already present in get_trip_itinerary. If the traveler already scheduled something, plan around it, not on top of it.
- Check get_weather for the destination(s) you are planning before scheduling outdoor activities, and prefer search_destination for real places to visit; say so in notes when a choice is weather-dependent.
- Respect the budget status get_trip_itinerary reports. If the trip is already over budget, prefer free or low-cost activities and say in the rationale that cost was a constraint. You never compute or adjust any budget number yourself.
- Be economical with tool calls: you have a hard limit of 8, plus a wall-clock limit for the whole run. Retrieve what you need for the trip as a whole rather than one call per item.
- Chronology matters: a day's items must be ordered by startTime, endTime (when present) must be after startTime, and you must leave realistic time for transfers between places.
- Every assumption you make because no data covered it belongs in the assumptions array. Do not disguise a guess as a fact.
- Output the schedule via provide_final_answer. Do not call any write tool -- you have none, and persisting the plan is the caller's job.`,
  allowedTools: [
    "get_trip",
    "get_trip_itinerary",
    "get_weather",
    "search_destination",
    "search_trip_knowledge",
  ],
  outputSchema: planningOutputSchema,
});

/**
 * Maps a validated plan onto persisted item drafts, checking in code the
 * constraints the prompt asked for. Fail-closed: one out-of-range date or
 * unknown city rejects the entire plan with a specific message, rather
 * than persisting the rest and quietly dropping what didn't fit.
 *
 * A city match is case- and whitespace-insensitive (models vary in
 * capitalization); it still must be a real destination on *this* trip.
 */
export function groundPlanItems(
  plan: PlanningOutput,
  trip: TripRecord,
  destinations: DestinationRecord[],
): PlanItemDraft[] {
  if (!trip.startDate || !trip.endDate) {
    throw new ValidationError(
      "The trip has no start and end dates, so a plan cannot be grounded to them.",
    );
  }

  const tripStart = calendarDayOf(trip.startDate);
  const tripEnd = calendarDayOf(trip.endDate);
  const destinationByCity = new Map(
    destinations.map((destination) => [destination.city.trim().toLowerCase(), destination]),
  );

  const drafts: PlanItemDraft[] = [];
  const seenDates = new Set<string>();

  for (const day of plan.days) {
    if (day.date < tripStart || day.date > tripEnd) {
      throw new ValidationError(
        `The generated plan scheduled ${day.date}, which is outside the trip's dates (${tripStart} to ${tripEnd}).`,
      );
    }
    if (seenDates.has(day.date)) {
      throw new ValidationError(`The generated plan contains two entries for ${day.date}.`);
    }
    seenDates.add(day.date);

    for (const item of day.items) {
      const destination = destinationByCity.get(item.destinationCity.trim().toLowerCase());
      if (!destination) {
        throw new ValidationError(
          `The generated plan referenced "${item.destinationCity}", which is not one of this trip's destinations (${destinations
            .map((entry) => entry.city)
            .join(", ")}).`,
        );
      }

      if (item.endTime && item.endTime < item.startTime) {
        throw new ValidationError(
          `The generated plan has "${item.title}" ending (${item.endTime}) before it starts (${item.startTime}).`,
        );
      }

      drafts.push({
        itineraryDay: day.date,
        startTime: item.startTime,
        endTime: item.endTime ?? null,
        title: item.title,
        itemType: item.itemType,
        location: item.location ?? null,
        // Resolved from the trip's own destinations -- never from a
        // destination id the model could have made up.
        destinationId: destination.id,
        notes: item.notes ?? null,
      });
    }
  }

  return drafts;
}

export interface PlanningAgentResult {
  planRunId: string;
  days: PlanningOutput["days"];
  rationale: string;
  assumptions: string[];
  itemsCreated: number;
  aiItemsReplaced: number;
  budget: ItineraryBudgetStatus;
}

function buildPlanningMessage(trip: TripRecord, destinations: DestinationRecord[]): string {
  const days: string[] = [];
  const start = calendarDayOf(trip.startDate as Date);
  const end = calendarDayOf(trip.endDate as Date);
  for (let day = start; day <= end; day = nextDay(day)) {
    days.push(day);
  }

  const destinationLines = destinations.map(
    (destination, index) =>
      `  ${index + 1}. ${destination.city}, ${destination.country}` +
      (destination.arrivalDate ? ` (arrive ${calendarDayOf(destination.arrivalDate)})` : "") +
      (destination.departureDate ? ` (leave ${calendarDayOf(destination.departureDate)})` : ""),
  );

  return `Plan this trip:
- Trip: "${trip.title}"
- Dates: ${start} to ${end} (${days.length} day${days.length === 1 ? "" : "s"}: ${days.join(", ")})
- Destinations, in order (the only cities your plan may schedule in):
${destinationLines.join("\n")}

Start by reading get_trip_itinerary so you build on the traveler's existing items and know the budget position, then retrieve what else you need (weather, real places, uploaded documents). Produce the day-by-day plan.`;
}

function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export async function runPlanningAgentForUser(
  tripId: string,
  userId: string,
): Promise<PlanningAgentResult> {
  const trip = await getTrip(tripId, userId);

  // Checked before spending an LLM call, and stated specifically rather
  // than surfacing later as a confusing tool error.
  if (!trip.startDate || !trip.endDate) {
    throw new ValidationError(
      "Set this trip's start and end dates before generating a plan — a day-by-day schedule needs a real date range to fit into.",
    );
  }

  const destinations = await getTripDestinations(tripId, userId);
  if (destinations.length === 0) {
    throw new ValidationError(
      "Add at least one destination to this trip before generating a plan — the planner schedules only in the trip's own destinations.",
    );
  }

  // Same refusal as the Risk Agent: an LLM-backed planner has no honest
  // mock, so an unconfigured key is reported as what it is. The manual
  // itinerary and deterministic budget validation work without it.
  if (!providerAvailability.anthropic) {
    throw new ProviderError(
      "planning_agent",
      "Itinerary planning requires an Anthropic API key, which isn't configured. Manual itinerary items and budget validation are unaffected and remain fully available — only the natural-language planner needs this key.",
    );
  }

  const requestId = generateRequestId();
  const result = await runAgent(planningAgent, buildPlanningMessage(trip, destinations), {
    userId,
    requestId,
  });

  if (!result.success) {
    throw new ProviderError(
      "planning_agent",
      `The planning agent could not complete this request: ${result.reason}.`,
    );
  }

  // Code-level grounding check. The prompt asks for these constraints;
  // this enforces them before a single row is written.
  const drafts = groundPlanItems(result.data, trip, destinations);

  const planRunId = randomUUID();
  const { items, replacedCount, budget } = await replaceGeneratedPlan(
    tripId,
    userId,
    planRunId,
    drafts,
  );

  return {
    planRunId,
    days: result.data.days,
    rationale: result.data.rationale,
    assumptions: result.data.assumptions,
    itemsCreated: items.length,
    aiItemsReplaced: replacedCount,
    budget,
  };
}
