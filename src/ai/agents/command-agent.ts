import { z } from "zod";
import { defineAgent } from "@/ai/agents/types";
import { runAgent, type OrchestratorToolCall } from "@/ai/orchestrator";
import { getTrip, getTripDestinations } from "@/modules/trip/trip-service";
import type { DestinationRecord, TripRecord } from "@/modules/trip/trip-service";
import { providerAvailability } from "@/config/env";
import { generateRequestId } from "@/shared/api-response";
import { ProviderError, ValidationError } from "@/shared/errors";

/**
 * Command Agent — Phase 22, the Command Bar.
 *
 * One natural-language command in, one structured answer out, and every
 * claim in that answer traced to a tool that was really called during
 * the run. This is the generalist the architecture's request-flow
 * diagram (docs/ARCHITECTURE.md Section 8) described back in Phase 1:
 * the traveler asks something about a trip, the orchestrator picks
 * whatever read tools it needs, and the response carries Decision /
 * Evidence / Reasoning / Recommendation / Confidence — the same
 * explainable shape as Phase 17's risk explanation, generalized to any
 * question about the trip.
 *
 * Three properties are enforced in code, not just requested in the
 * prompt:
 *
 *  1. It is read-only. Its allowed tools are exactly the registry's
 *     read tools — no `create_recommendation`, no `create_alert`. A
 *     command bar question must never mutate a trip as a side effect of
 *     being asked.
 *  2. Every evidence entry must name a tool that was actually invoked in
 *     this run (see `findUninvokedSources`). The orchestrator records a
 *     real call log (`OrchestratorToolCall[]`), so an answer that cites
 *     a check the system never performed is rejected rather than
 *     displayed with a fabricated provenance.
 *  3. It needs no fake data path. Without an Anthropic key it refuses
 *     with a clear `ProviderError`, exactly like the Risk, Research, and
 *     Planning agents — every deterministic feature of the trip page
 *     keeps working, only the natural-language command bar needs the
 *     model.
 */

export const commandRequestSchema = z.object({
  command: z.string().trim().min(1, "A command is required.").max(500),
});

export const commandEvidenceSchema = z.object({
  source: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe(
      "The exact name of the tool you called to obtain this observation, e.g. get_flight_status. Never a tool you did not actually call in this run.",
    ),
  observation: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      "The specific fact that tool returned: a status, a delay in minutes, a temperature, a rate, a title/URL. Not a summary of your reasoning.",
    ),
});

export const commandResponseSchema = z.object({
  decision: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      "The direct answer to the command in one or two sentences. If the command asked a yes/no question, answer it here.",
    ),
  evidence: z
    .array(commandEvidenceSchema)
    .max(10)
    .describe(
      "Every recorded observation the answer rests on, each traced to the tool call that produced it. Empty only if no tool returned anything useful.",
    ),
  reasoningSummary: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe("Why the evidence leads to this answer, in plain language."),
  recommendationText: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe(
      "The concrete next step for the traveler, or an explicit 'no action needed' — never manufactured urgency.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How confident you are in this answer given the evidence actually retrieved."),
  dataGaps: z
    .array(z.string().trim().min(1).max(300))
    .max(10)
    .describe(
      "Anything the command needed that no tool could confirm — a failed provider call, a missing document, no snapshot yet. Say it here instead of guessing.",
    ),
});

export type CommandEvidence = z.infer<typeof commandEvidenceSchema>;
export type CommandResponse = z.infer<typeof commandResponseSchema>;

/**
 * The reads-only subset: all 11 registry tools that cannot write. The
 * two action tools (`create_recommendation`, `create_alert`) are
 * deliberately absent — see the file header. The orchestrator's 8
 * tool-call budget still applies on top of this.
 */
export const commandAgent = defineAgent({
  name: "command_agent",
  role: `You are the TripOS command bar: the traveler asks one question or gives one instruction about a specific trip, and you answer it from that trip's real data.

Rules, no exceptions:
- Ground every factual claim in a tool call made during THIS run. You may use get_trip, get_trip_itinerary, get_trip_documents, get_flight_status, get_weather, get_currency_rate, calculate_budget, search_destination, search_trip_knowledge, get_trip_risk, and get_trip_risk_history. Never answer from your own memory of a city, airline, or price — not even when you are confident.
- Every entry in your evidence array must name a tool you actually called in this run, exactly as named above, and quote what it really returned (a status string, delay minutes, temperature, rate, search result title/URL). A fabricated or unattributed source fails validation and the whole answer is discarded.
- Never state a number no tool returned. Do not estimate prices, durations, distances, or probabilities. If a cost question needs conversion, call calculate_budget and report its output rather than doing the arithmetic yourself.
- Live provider tools can fail. When one does, put that in dataGaps with the tool's own error message, and answer around the gap. Never fill a failed check with a plausible guess.
- The traveler's command may be ambiguous. If it could reasonably mean two different things, pick the most operationally useful reading, say which reading you took in the decision, and note the ambiguity in dataGaps.
- Be economical: you have a hard limit of 8 tool calls and a wall-clock limit for the whole run. Retrieve what answers the command, not everything about the trip.
- You have no write tools and you must not claim anything was changed, booked, cancelled, or notified. You report and recommend; the traveler acts.
- Keep the answer tight and operational: decision first, evidence second, recommendation third. Output via provide_final_answer.`,
  allowedTools: [
    "get_trip",
    "get_trip_itinerary",
    "get_trip_documents",
    "get_flight_status",
    "get_weather",
    "get_currency_rate",
    "calculate_budget",
    "search_destination",
    "search_trip_knowledge",
    "get_trip_risk",
    "get_trip_risk_history",
  ],
  outputSchema: commandResponseSchema,
});

/**
 * Evidence grounding, enforced in code. Returns the sources that were
 * never invoked so the error can name them precisely.
 *
 * A source is grounded if the tool was *called*, whether or not the call
 * succeeded: "the weather provider returned an error" is an honest,
 * checkable statement about a real invocation, and the call log shows
 * the failure. What this rejects is provenance for a check that never
 * happened at all.
 */
export function findUninvokedSources(
  evidence: Array<{ source: string }>,
  toolCalls: OrchestratorToolCall[],
): string[] {
  const invoked = new Set(toolCalls.map((call) => call.name));
  return evidence.map((item) => item.source).filter((source) => !invoked.has(source));
}

export function assertEvidenceWasInvoked(
  evidence: Array<{ source: string }>,
  toolCalls: OrchestratorToolCall[],
): void {
  const uninvoked = findUninvokedSources(evidence, toolCalls);
  if (uninvoked.length > 0) {
    throw new ValidationError(
      `The command answer cited tools that were never called in this run: ${[
        ...new Set(uninvoked),
      ].join(", ")}. Rejecting rather than showing an answer with fabricated provenance.`,
    );
  }
}

export interface CommandAgentResult extends CommandResponse {
  command: string;
  /** The real invocation trail, in order — what the system actually checked. */
  toolCalls: OrchestratorToolCall[];
  toolCallsUsed: number;
  durationMs: number;
  tokensUsed: number;
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildCommandMessage(
  trip: TripRecord,
  destinations: DestinationRecord[],
  command: string,
): string {
  const destinationLines =
    destinations.length === 0
      ? "  (none set yet)"
      : destinations
          .map(
            (destination) =>
              `  - ${destination.city}, ${destination.country} (destinationId: ${destination.id})`,
          )
          .join("\n");

  return `Trip context (already loaded for you — you do not need a tool call to read these fields):
- Title: "${trip.title}"
- Status: ${trip.status}
- Dates: ${trip.startDate ? dayOf(trip.startDate) : "not set"} to ${trip.endDate ? dayOf(trip.endDate) : "not set"}
- Destinations (destinationId is what get_weather takes):
${destinationLines}
- Today (server date): ${new Date().toISOString().slice(0, 10)}

The traveler's command:
"${command}"

Retrieve whatever this command actually needs from the tools before answering.`;
}

/**
 * User-facing entry point. Ownership and input are checked before the
 * key check, and the key check before any model call, so an unauthorized
 * request or a blank command never costs a token.
 */
export async function runCommandForUser(
  tripId: string,
  userId: string,
  rawCommand: string,
): Promise<CommandAgentResult> {
  const trip = await getTrip(tripId, userId);
  const { command } = commandRequestSchema.parse({ command: rawCommand });

  // Same refusal as the Risk, Research, and Planning agents: an answer
  // composed without a model has no honest mock, so a missing key is
  // reported as what it is. Everything deterministic on the trip page
  // remains available.
  if (!providerAvailability.anthropic) {
    throw new ProviderError(
      "command_bar",
      "The command bar requires an Anthropic API key, which isn't configured. It will not answer from fabricated data without a model — every other trip feature, including status checks, risk scoring, and the itinerary, works without this key.",
    );
  }

  const destinations = await getTripDestinations(tripId, userId);
  const requestId = generateRequestId();

  const result = await runAgent(commandAgent, buildCommandMessage(trip, destinations, command), {
    userId,
    requestId,
  });

  if (!result.success) {
    throw new ProviderError(
      "command_bar",
      `The command bar could not complete this request: ${result.reason}.`,
    );
  }

  // Code-level grounding check. The prompt asks for real provenance;
  // this enforces it against the orchestrator's own call log.
  assertEvidenceWasInvoked(result.data.evidence, result.toolCalls);

  return {
    ...result.data,
    command,
    toolCalls: result.toolCalls,
    toolCallsUsed: result.toolCallsUsed,
    durationMs: result.durationMs,
    tokensUsed: result.tokensUsed,
  };
}
