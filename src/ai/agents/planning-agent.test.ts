import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { pool } from "@/infrastructure/db";
import {
  addDestinationToTrip,
  createTrip,
  getTripEventHistory,
  type DestinationRecord,
  type TripRecord,
} from "@/modules/trip/trip-service";
import { addItineraryItem, listTripItinerary } from "@/modules/itinerary/itinerary-service";
import { NotFoundError, ProviderError, ValidationError } from "@/shared/errors";

const mockCreate = vi.fn();

// `function`, not an arrow: the Anthropic client is constructed with
// `new`, and arrow functions have no [[Construct]].
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(function MockAnthropic() {
      return { messages: { create: mockCreate } };
    }),
  };
});

/**
 * The agent refuses without a key, which is correct in production but
 * would make every test assert the refusal instead of the grounding
 * logic. Mocked explicitly so tests behave the same everywhere.
 */
vi.mock("@/config/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/env")>();
  return {
    ...actual,
    providerAvailability: { ...actual.providerAvailability, anthropic: true },
  };
});

const { providerAvailability } = await import("@/config/env");

import {
  groundPlanItems,
  planningAgent,
  runPlanningAgentForUser,
  type PlanningOutput,
} from "@/ai/agents/planning-agent";

const OWNER_EMAIL = "planning-agent-owner@example.com";
const OTHER_EMAIL = "planning-agent-other@example.com";
let ownerId: string;
let otherId: string;

async function createTestUser(email: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'Test') RETURNING id`,
    [email],
  );
  return result.rows[0].id;
}

async function cleanupTestUsers(): Promise<void> {
  await pool.query(`DELETE FROM users WHERE email IN ($1, $2)`, [OWNER_EMAIL, OTHER_EMAIL]);
}

function anthropicResponse(content: unknown[]) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content,
    model: "claude-sonnet-5",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function finalAnswer(input: Record<string, unknown>) {
  return anthropicResponse([{ type: "tool_use", id: "tu_1", name: "provide_final_answer", input }]);
}

function validPlan(): PlanningOutput {
  return {
    days: [
      {
        date: "2026-10-03",
        items: [
          {
            title: "Arrival and hotel check-in",
            itemType: "FLIGHT",
            startTime: "09:00",
            endTime: "11:00",
            destinationCity: "Addis Ababa",
            location: "Bole International Airport",
            notes: "Allow time for immigration.",
          },
        ],
      },
      {
        date: "2026-10-05",
        items: [
          {
            title: "National Museum",
            itemType: "ACTIVITY",
            startTime: "10:00",
            destinationCity: "Addis Ababa",
          },
        ],
      },
    ],
    rationale: "A light arrival day, then the museum on the last full day.",
    assumptions: ["Museum opening hours were not confirmed by a retrieved source."],
  };
}

beforeEach(async () => {
  await cleanupTestUsers();
  mockCreate.mockReset();
  ownerId = await createTestUser(OWNER_EMAIL);
  otherId = await createTestUser(OTHER_EMAIL);
});

afterEach(async () => {
  await cleanupTestUsers();
});

async function planningTrip(userId = ownerId) {
  const trip = await createTrip(userId, {
    title: "Planning trip",
    startDate: new Date("2026-10-03T00:00:00Z"),
    endDate: new Date("2026-10-05T00:00:00Z"),
  });
  const destination = await addDestinationToTrip(trip.id, userId, {
    city: "Addis Ababa",
    country: "Ethiopia",
  });
  return { trip, destination };
}

describe("groundPlanItems (pure, fail-closed)", () => {
  const trip = {
    id: "trip-1",
    userId: "user-1",
    title: "t",
    status: "PLANNING" as const,
    startDate: new Date("2026-10-03T00:00:00Z"),
    endDate: new Date("2026-10-05T00:00:00Z"),
    budgetAmount: null,
    budgetCurrency: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies TripRecord;

  const destinations = [
    { id: "dest-1", city: "Addis Ababa", country: "Ethiopia" },
    { id: "dest-2", city: "Dubai", country: "United Arab Emirates" },
  ] as DestinationRecord[];

  it("maps each item's city to the trip's real destination id", () => {
    const drafts = groundPlanItems(validPlan(), trip, destinations);
    expect(drafts).toHaveLength(2);
    expect(drafts[0].destinationId).toBe("dest-1");
    expect(drafts[1].itineraryDay).toBe("2026-10-05");
  });

  it("matches a destination city case-insensitively", () => {
    const plan = validPlan();
    plan.days[0].items[0].destinationCity = "  addis ababa ";
    expect(() => groundPlanItems(plan, trip, destinations)).not.toThrow();
  });

  it("rejects a city that is not on this trip", () => {
    const plan = validPlan();
    plan.days[0].items[0].destinationCity = "Paris";
    expect(() => groundPlanItems(plan, trip, destinations)).toThrow(ValidationError);
    expect(() => groundPlanItems(plan, trip, destinations)).toThrow(/Paris/);
  });

  it("rejects a date outside the trip's range", () => {
    const plan = validPlan();
    plan.days[0].date = "2026-10-02";
    expect(() => groundPlanItems(plan, trip, destinations)).toThrow(ValidationError);
  });

  it("rejects two entries for the same day", () => {
    const plan = validPlan();
    plan.days[1].date = "2026-10-03";
    // Keep the second date in range so the failure is specifically the duplicate.
    expect(() => groundPlanItems(plan, trip, destinations)).toThrow(/two entries/);
  });

  it("rejects an item that ends before it starts", () => {
    const plan = validPlan();
    plan.days[0].items[0].startTime = "14:00";
    plan.days[0].items[0].endTime = "13:00";
    expect(() => groundPlanItems(plan, trip, destinations)).toThrow(ValidationError);
  });

  it("has no cost fields in its output schema at all", () => {
    // The strongest form of "the model never invents a price": there is
    // nowhere in the validated shape for a price to be returned, so a
    // fabricated one cannot reach the database even accidentally.
    const jsonSchema = JSON.stringify(z.toJSONSchema(planningAgent.outputSchema));
    expect(jsonSchema).not.toMatch(/cost/i);
    expect(jsonSchema).not.toMatch(/price/i);
    expect(jsonSchema).not.toMatch(/currency/i);
  });
});

describe("runPlanningAgentForUser", () => {
  it("refuses without trip dates, before spending a model call", async () => {
    const trip = await createTrip(ownerId, { title: "No dates" });
    await addDestinationToTrip(trip.id, ownerId, { city: "Addis Ababa", country: "Ethiopia" });

    await expect(runPlanningAgentForUser(trip.id, ownerId)).rejects.toBeInstanceOf(ValidationError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses without a destination, before spending a model call", async () => {
    const trip = await createTrip(ownerId, {
      title: "No destinations",
      startDate: new Date("2026-10-03T00:00:00Z"),
      endDate: new Date("2026-10-05T00:00:00Z"),
    });

    await expect(runPlanningAgentForUser(trip.id, ownerId)).rejects.toBeInstanceOf(ValidationError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a non-owner before making any model call", async () => {
    const { trip } = await planningTrip();

    await expect(runPlanningAgentForUser(trip.id, otherId)).rejects.toBeInstanceOf(NotFoundError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses clearly, without a model call, when no Anthropic key is configured", async () => {
    const { trip } = await planningTrip();
    vi.spyOn(providerAvailability, "anthropic", "get").mockReturnValue(false);
    try {
      await expect(runPlanningAgentForUser(trip.id, ownerId)).rejects.toBeInstanceOf(ProviderError);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("persists a grounded plan and reports what it created", async () => {
    const { trip, destination } = await planningTrip();
    mockCreate.mockResolvedValueOnce(finalAnswer(validPlan()));

    const result = await runPlanningAgentForUser(trip.id, ownerId);

    expect(result.itemsCreated).toBe(2);
    expect(result.aiItemsReplaced).toBe(0);
    expect(result.assumptions).toHaveLength(1);

    const { items } = await listTripItinerary(trip.id, ownerId);
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.source === "AI_PLANNER")).toBe(true);
    expect(items[0].destinationId).toBe(destination.id);
    // No cost is ever written by a generated plan.
    expect(items.every((item) => item.estimatedCost === null && item.currency === null)).toBe(true);

    const events = await getTripEventHistory(trip.id, ownerId);
    expect(events.some((event) => event.eventType === "ITINERARY_PLANNED")).toBe(true);
  });

  it("writes nothing when the plan references an unknown city", async () => {
    const { trip } = await planningTrip();
    const plan = validPlan();
    plan.days[0].items[0].destinationCity = "Paris";
    mockCreate.mockResolvedValueOnce(finalAnswer(plan));

    await expect(runPlanningAgentForUser(trip.id, ownerId)).rejects.toBeInstanceOf(ValidationError);

    const { items } = await listTripItinerary(trip.id, ownerId);
    expect(items).toEqual([]);
  });

  it("replaces only its own previous items on a re-run, keeping the traveler's", async () => {
    const { trip } = await planningTrip();

    mockCreate.mockResolvedValueOnce(finalAnswer(validPlan()));
    await runPlanningAgentForUser(trip.id, ownerId);

    const userItem = await addItineraryItem(trip.id, ownerId, {
      day: "2026-10-04",
      title: "My own dinner reservation",
      startTime: "19:00",
    });

    mockCreate.mockResolvedValueOnce(finalAnswer(validPlan()));
    const second = await runPlanningAgentForUser(trip.id, ownerId);

    expect(second.aiItemsReplaced).toBe(2);
    const { items } = await listTripItinerary(trip.id, ownerId);
    expect(items.filter((item) => item.source === "AI_PLANNER")).toHaveLength(2);
    expect(items.find((item) => item.id === userItem.id)).toBeDefined();
  });

  it("propagates an orchestrator failure as a ProviderError", async () => {
    const { trip } = await planningTrip();
    mockCreate.mockRejectedValue(new Error("simulated network failure"));

    await expect(runPlanningAgentForUser(trip.id, ownerId)).rejects.toBeInstanceOf(ProviderError);
  });

  it("offers the agent only read tools, with no write path to act on its own", () => {
    expect(planningAgent.allowedTools).toContain("get_trip_itinerary");
    for (const writeTool of ["create_recommendation", "create_alert"]) {
      expect(planningAgent.allowedTools).not.toContain(writeTool);
    }
  });
});
