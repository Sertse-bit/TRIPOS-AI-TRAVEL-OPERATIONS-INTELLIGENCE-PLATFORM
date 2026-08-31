import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/infrastructure/db";
import { callTool, getAllToolDefinitions, isApprovedTool } from "@/ai/tools/registry";
import { createTrip, addFlightToTrip } from "@/modules/trip/trip-service";

const OWNER_EMAIL = "tool-owner@example.com";
const OTHER_EMAIL = "tool-other@example.com";
let ownerId: string;
let otherId: string;

async function createTestUser(email: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'Test') RETURNING id`,
    [email],
  );
  return result.rows[0].id;
}

beforeEach(async () => {
  ownerId = await createTestUser(OWNER_EMAIL);
  otherId = await createTestUser(OTHER_EMAIL);
});

afterEach(async () => {
  await pool.query(`DELETE FROM users WHERE email IN ($1, $2)`, [OWNER_EMAIL, OTHER_EMAIL]);
});

describe("tool registry: the approved-tools-only boundary", () => {
  it("rejects a tool name that isn't registered, without attempting anything", async () => {
    const result = await callTool(
      "delete_all_trips", // not a real tool -- this is the point
      {},
      { userId: ownerId, requestId: "test-req" },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("UNKNOWN_TOOL");
    }
  });

  it("isApprovedTool correctly discriminates real tools from arbitrary strings", () => {
    expect(isApprovedTool("get_trip")).toBe(true);
    expect(isApprovedTool("get_weather")).toBe(true);
    expect(isApprovedTool("run_shell_command")).toBe(false);
    expect(isApprovedTool("__proto__")).toBe(false);
    expect(isApprovedTool("constructor")).toBe(false);
  });

  it("exposes exactly the 10 tools named in the brief, no more, no fewer", () => {
    const names = getAllToolDefinitions().map((t) => t.name);
    expect(names.sort()).toEqual(
      [
        "get_flight_status",
        "get_weather",
        "get_currency_rate",
        "search_destination",
        "get_trip",
        "get_trip_documents",
        "search_trip_knowledge",
        "calculate_budget",
        "create_recommendation",
        "create_alert",
      ].sort(),
    );
  });
});

describe("tool registry: input validation returns structured errors, never throws", () => {
  it("returns a VALIDATION_ERROR result for malformed input rather than throwing", async () => {
    const result = await callTool(
      "get_trip",
      { tripId: "not-a-uuid-at-all" },
      { userId: ownerId, requestId: "test-req" },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("returns a VALIDATION_ERROR when required fields are missing entirely", async () => {
    const result = await callTool(
      "create_alert",
      { tripId: "x" },
      { userId: ownerId, requestId: "r" },
    );
    expect(result.success).toBe(false);
  });

  it("rejects a confidence value outside [0,1] on create_recommendation", async () => {
    const trip = await createTrip(ownerId, { title: "Confidence test" });
    const result = await callTool(
      "create_recommendation",
      {
        tripId: trip.id,
        decision: "x",
        evidence: {},
        reasoningSummary: "x",
        recommendationText: "x",
        confidence: 1.5, // out of bounds
      },
      { userId: ownerId, requestId: "r" },
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("tool registry: authorization is enforced against the injected userId, never the input", () => {
  it("get_trip fails for a user who doesn't own the trip, even with a perfectly valid tripId", async () => {
    const trip = await createTrip(ownerId, { title: "Owner's private trip" });

    // Simulates exactly the threat model this matters for: an LLM
    // (however it got the ID -- confusion, injection, anything) calling
    // get_trip with a real tripId that isn't the calling user's.
    const result = await callTool(
      "get_trip",
      { tripId: trip.id },
      { userId: otherId, requestId: "r" },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("get_flight_status fails when the flight belongs to a trip the caller doesn't own", async () => {
    const trip = await createTrip(ownerId, { title: "Flight owner test" });
    const flight = await addFlightToTrip(trip.id, ownerId, {
      flightNumber: "ET602",
      airline: "Ethiopian Airlines",
      departureAirport: "ADD",
      arrivalAirport: "DXB",
      scheduledDeparture: new Date("2026-09-10T08:00:00Z"),
      scheduledArrival: new Date("2026-09-10T13:30:00Z"),
    });

    const result = await callTool(
      "get_flight_status",
      { tripId: trip.id, flightRecordId: flight.id },
      { userId: otherId, requestId: "r" },
    );
    expect(result.success).toBe(false);
  });

  it("create_alert cannot be used to notify a different user than the trip's actual owner", async () => {
    const trip = await createTrip(ownerId, { title: "Alert test" });
    // otherId tries to create an alert on a trip they don't own.
    const result = await callTool(
      "create_alert",
      { tripId: trip.id, title: "Fake alert", body: "Should not be created" },
      { userId: otherId, requestId: "r" },
    );
    expect(result.success).toBe(false);

    const notifications = await pool.query(
      `SELECT count(*) FROM notifications WHERE user_id = $1`,
      [otherId],
    );
    expect(Number(notifications.rows[0].count)).toBe(0);
  });
});

describe("tool registry: successful calls, structured output, and side effects", () => {
  it("get_trip returns the full digital twin for the actual owner", async () => {
    const trip = await createTrip(ownerId, { title: "Real access test" });
    const result = await callTool(
      "get_trip",
      { tripId: trip.id },
      { userId: ownerId, requestId: "r" },
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { trip: { title: string } };
      expect(data.trip.title).toBe("Real access test");
    }
  });

  it("create_recommendation persists a real row and records a trip event", async () => {
    const trip = await createTrip(ownerId, { title: "Recommendation test" });
    const result = await callTool(
      "create_recommendation",
      {
        tripId: trip.id,
        decision: "Flight ET602 delayed",
        evidence: { source: "test" },
        reasoningSummary: "Test reasoning",
        recommendationText: "Test recommendation",
        confidence: 0.8,
      },
      { userId: ownerId, requestId: "r" },
    );

    expect(result.success).toBe(true);

    const rows = await pool.query(`SELECT * FROM recommendations WHERE trip_id = $1`, [trip.id]);
    expect(rows.rows).toHaveLength(1);
    expect(Number(rows.rows[0].confidence)).toBe(0.8);

    const events = await pool.query(
      `SELECT * FROM trip_events WHERE trip_id = $1 AND event_type = 'RECOMMENDATION_CREATED'`,
      [trip.id],
    );
    expect(events.rows).toHaveLength(1);
  });

  it("create_alert persists a notification for the trip's real owner", async () => {
    const trip = await createTrip(ownerId, { title: "Alert owner test" });
    const result = await callTool(
      "create_alert",
      { tripId: trip.id, title: "Test alert", body: "Test body" },
      { userId: ownerId, requestId: "r" },
    );

    expect(result.success).toBe(true);
    const rows = await pool.query(`SELECT * FROM notifications WHERE user_id = $1`, [ownerId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].title).toBe("Test alert");
  });

  it("search_trip_knowledge honestly reports no documents rather than fabricating a match", async () => {
    const trip = await createTrip(ownerId, { title: "Empty knowledge test" });
    const result = await callTool(
      "search_trip_knowledge",
      { tripId: trip.id, query: "when does my flight depart" },
      { userId: ownerId, requestId: "r" },
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { status: string; matches: unknown[] };
      expect(data.status).toBe("no_documents");
      expect(data.matches).toEqual([]);
    }
  });

  it("calculate_budget performs a real, deterministic conversion using a real exchange rate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          timestamp: 1789050000,
          base: "ETB",
          rates: { AED: 0.0218 },
        }),
      }),
    );

    const trip = await createTrip(ownerId, { title: "Budget test" });
    const result = await callTool(
      "calculate_budget",
      { tripId: trip.id, amount: 100, fromCurrency: "ETB", toCurrency: "AED" },
      { userId: ownerId, requestId: "r" },
    );

    vi.unstubAllGlobals();

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { convertedAmount: number; exchangeRate: number };
      // The multiplication happens in code, not something an LLM computed
      // or guessed at -- this is what "deterministic" actually means here.
      expect(data.exchangeRate).toBe(0.0218);
      expect(data.convertedAmount).toBe(2.18);
    }
  });
});
