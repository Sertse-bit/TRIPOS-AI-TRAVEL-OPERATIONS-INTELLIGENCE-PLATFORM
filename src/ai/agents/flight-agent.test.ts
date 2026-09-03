import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redis } from "@/infrastructure/redis";
import { pool } from "@/infrastructure/db";
import { createTrip, addFlightToTrip } from "@/modules/trip/trip-service";
import {
  mapProviderStatusToFlightStatus,
  processFlightStatusUpdate,
  runFlightAgentForUser,
} from "@/ai/agents/flight-agent";
import { NotFoundError } from "@/shared/errors";
import type { NormalizedFlightStatus } from "@/integrations/aviation/provider";

const OWNER_EMAIL = "flight-agent-owner@example.com";
const OTHER_EMAIL = "flight-agent-other@example.com";
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
  // The resilience layer (Phase 6) caches Aviation provider results by
  // flight number, not by flightRecordId or test case -- multiple tests
  // in this file reuse "ET602", so without clearing this first, a later
  // test could silently be served a previous test's cached response and
  // still happen to pass (both use plain-SCHEDULED fixtures by default),
  // without genuinely proving isolation.
  await redis.del("resilience:aviation:ET602");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await pool.query(`DELETE FROM users WHERE email IN ($1, $2)`, [OWNER_EMAIL, OTHER_EMAIL]);
});

function baseNormalized(overrides: Partial<NormalizedFlightStatus> = {}): NormalizedFlightStatus {
  return {
    flightDate: "2026-09-10",
    flightStatus: "scheduled",
    airline: { name: "Ethiopian Airlines", iata: "ET" },
    flight: { number: "602", iata: "ET602" },
    departure: {
      airport: "Bole International",
      iata: "ADD",
      scheduled: "2026-09-10T08:00:00Z",
      estimated: null,
      actual: null,
      delayMinutes: null,
      terminal: "2",
      gate: "12",
    },
    arrival: {
      airport: "Dubai International",
      iata: "DXB",
      scheduled: "2026-09-10T13:30:00Z",
      estimated: null,
      actual: null,
      delayMinutes: null,
      terminal: "1",
      gate: null,
    },
    ...overrides,
  };
}

describe("mapProviderStatusToFlightStatus", () => {
  it("maps cancelled and diverted both to CANCELLED", () => {
    expect(mapProviderStatusToFlightStatus(baseNormalized({ flightStatus: "cancelled" }))).toBe(
      "CANCELLED",
    );
    expect(mapProviderStatusToFlightStatus(baseNormalized({ flightStatus: "diverted" }))).toBe(
      "CANCELLED",
    );
  });

  it("maps landed to LANDED", () => {
    expect(mapProviderStatusToFlightStatus(baseNormalized({ flightStatus: "landed" }))).toBe(
      "LANDED",
    );
  });

  it("maps scheduled/active with no meaningful delay to SCHEDULED", () => {
    expect(mapProviderStatusToFlightStatus(baseNormalized({ flightStatus: "scheduled" }))).toBe(
      "SCHEDULED",
    );
    expect(mapProviderStatusToFlightStatus(baseNormalized({ flightStatus: "active" }))).toBe(
      "SCHEDULED",
    );
  });

  it("derives DELAYED from delay minutes, not the raw status string -- even for an 'active' (airborne) flight", () => {
    const delayed = baseNormalized({
      flightStatus: "active",
      departure: { ...baseNormalized().departure, delayMinutes: 45 },
    });
    expect(mapProviderStatusToFlightStatus(delayed)).toBe("DELAYED");
  });

  it("does not flag a trivial delay (under the 15-minute threshold) as DELAYED", () => {
    const barelyLate = baseNormalized({
      departure: { ...baseNormalized().departure, delayMinutes: 5 },
    });
    expect(mapProviderStatusToFlightStatus(barelyLate)).toBe("SCHEDULED");
  });

  it("checks both departure and arrival delay, using whichever is worse", () => {
    const arrivalDelayed = baseNormalized({
      arrival: { ...baseNormalized().arrival, delayMinutes: 60 },
    });
    expect(mapProviderStatusToFlightStatus(arrivalDelayed)).toBe("DELAYED");
  });
});

describe("processFlightStatusUpdate: real pipeline against real Postgres", () => {
  it("records a baseline snapshot with no previous status and no event on the first check", async () => {
    const trip = await createTrip(ownerId, { title: "First check trip" });
    const flight = await addFlightToTrip(trip.id, ownerId, {
      flightNumber: "ET602",
      airline: "Ethiopian Airlines",
      departureAirport: "ADD",
      arrivalAirport: "DXB",
      scheduledDeparture: new Date("2026-09-10T08:00:00Z"),
      scheduledArrival: new Date("2026-09-10T13:30:00Z"),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [rawAviationstackFixture()] }),
      }),
    );

    const result = await processFlightStatusUpdate(flight.id);

    expect(result.previousStatus).toBeNull();
    expect(result.currentStatus).toBe("SCHEDULED");
    // No PREVIOUS status to differ from -- current design treats a
    // first-ever check as "changed" (null -> SCHEDULED is a genuine
    // transition), so an event IS expected here.
    expect(result.changed).toBe(true);
    expect(result.eventId).not.toBeNull();
  });

  it("does NOT emit a second event when a follow-up check finds no meaningful change", async () => {
    const trip = await createTrip(ownerId, { title: "No change trip" });
    const flight = await addFlightToTrip(trip.id, ownerId, {
      flightNumber: "ET602",
      airline: "Ethiopian Airlines",
      departureAirport: "ADD",
      arrivalAirport: "DXB",
      scheduledDeparture: new Date("2026-09-10T08:00:00Z"),
      scheduledArrival: new Date("2026-09-10T13:30:00Z"),
    });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ data: [rawAviationstackFixture()] }) }),
    );

    await processFlightStatusUpdate(flight.id); // baseline
    const secondResult = await processFlightStatusUpdate(flight.id); // identical status again

    expect(secondResult.changed).toBe(false);
    expect(secondResult.eventId).toBeNull();

    const events = await pool.query(
      `SELECT count(*) FROM trip_events WHERE entity_id = $1 AND event_type = 'FLIGHT_UPDATED'`,
      [flight.id],
    );
    expect(Number(events.rows[0].count)).toBe(1); // only the FIRST check's event
  });

  it("emits an event with the correct dedupe key when status genuinely changes to DELAYED", async () => {
    const trip = await createTrip(ownerId, { title: "Delay trip" });
    const flight = await addFlightToTrip(trip.id, ownerId, {
      flightNumber: "ET602",
      airline: "Ethiopian Airlines",
      departureAirport: "ADD",
      arrivalAirport: "DXB",
      scheduledDeparture: new Date("2026-09-10T08:00:00Z"),
      scheduledArrival: new Date("2026-09-10T13:30:00Z"),
    });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ data: [rawAviationstackFixture()] }) }),
    );
    await processFlightStatusUpdate(flight.id); // baseline: SCHEDULED

    // The resilience layer (Phase 6) caches by flight number for 2
    // minutes -- without clearing it, this second check would be served
    // from the FIRST response's cache and never reach the new mock
    // below at all. This mirrors reality: a real repeated poll (Phase
    // 19's Trip Watch) only sees fresh data once that TTL has elapsed.
    await redis.del("resilience:aviation:ET602");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            rawAviationstackFixture({
              departure: { ...rawAviationstackFixture().departure, delay: 45 },
            }),
          ],
        }),
      }),
    );
    const delayedResult = await processFlightStatusUpdate(flight.id);

    expect(delayedResult.previousStatus).toBe("SCHEDULED");
    expect(delayedResult.currentStatus).toBe("DELAYED");
    expect(delayedResult.changed).toBe(true);
    expect(delayedResult.delayMinutes).toBe(45);

    const event = await pool.query(`SELECT * FROM trip_events WHERE id = $1`, [
      delayedResult.eventId,
    ]);
    expect(event.rows[0].dedupe_key).toBe(
      `flight_updated:${flight.id}:${delayedResult.snapshotId}`,
    );
    expect(event.rows[0].metadata).toMatchObject({
      previousStatus: "SCHEDULED",
      currentStatus: "DELAYED",
      delayMinutes: 45,
    });
  });

  it("never invents flight data: records UNKNOWN rather than fabricating a status when the provider has nothing", async () => {
    const trip = await createTrip(ownerId, { title: "No data trip" });
    const flight = await addFlightToTrip(trip.id, ownerId, {
      flightNumber: "ZZ9999",
      airline: "Nonexistent Airline",
      departureAirport: "XXX",
      arrivalAirport: "YYY",
      scheduledDeparture: new Date("2026-09-10T08:00:00Z"),
      scheduledArrival: new Date("2026-09-10T13:30:00Z"),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }), // no matching flight
    );

    const result = await processFlightStatusUpdate(flight.id);
    expect(result.currentStatus).toBe("UNKNOWN");
  });
});

describe("runFlightAgentForUser: authorization", () => {
  it("rejects a caller who doesn't own the trip the flight belongs to", async () => {
    const trip = await createTrip(ownerId, { title: "Private flight trip" });
    const flight = await addFlightToTrip(trip.id, ownerId, {
      flightNumber: "ET602",
      airline: "Ethiopian Airlines",
      departureAirport: "ADD",
      arrivalAirport: "DXB",
      scheduledDeparture: new Date("2026-09-10T08:00:00Z"),
      scheduledArrival: new Date("2026-09-10T13:30:00Z"),
    });

    await expect(runFlightAgentForUser(trip.id, flight.id, otherId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

function rawAviationstackFixture(overrides: Record<string, unknown> = {}) {
  return {
    flight_date: "2026-09-10",
    flight_status: "scheduled",
    departure: {
      airport: "Bole International",
      timezone: "Africa/Addis_Ababa",
      iata: "ADD",
      icao: "HAAB",
      terminal: "2",
      gate: "12",
      delay: null,
      scheduled: "2026-09-10T08:00:00+00:00",
      estimated: null,
      actual: null,
      estimated_runway: null,
      actual_runway: null,
    },
    arrival: {
      airport: "Dubai International",
      timezone: "Asia/Dubai",
      iata: "DXB",
      icao: "OMDB",
      terminal: "1",
      gate: null,
      baggage: null,
      delay: null,
      scheduled: "2026-09-10T13:30:00+00:00",
      estimated: null,
      actual: null,
      estimated_runway: null,
      actual_runway: null,
    },
    airline: { name: "Ethiopian Airlines", iata: "ET", icao: "ETH" },
    flight: { number: "602", iata: "ET602", icao: "ETH602", codeshared: null },
    aircraft: null,
    live: null,
    ...overrides,
  };
}
