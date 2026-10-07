import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/infrastructure/db";
import { insertFlightStatusSnapshot } from "@/modules/trip/flight-repository";
import {
  addDestinationToTrip,
  addFlightToTrip,
  addTravelerToTrip,
  calculateOperationalState,
  createTrip,
  getTripDigitalTwin,
  getUserTripEntityCounts,
  listUserTrips,
} from "@/modules/trip/trip-service";

/**
 * Phase 29 read-path regression tests. The numbers these pin are not
 * "fast enough" thresholds — those belong to the measurement harness
 * (scripts/bench-read-paths.ts), which runs on a seeded dataset. What is
 * pinned here is the SCALING property that made the analytics page slow:
 * the cost of an aggregate must not grow with the number of trips, and
 * the cost of a trip's operational state must not grow with the number of
 * flights. Both are query-count assertions, which are stable in a way
 * wall-clock time is not.
 */
const OWNER_EMAIL = "perf-owner@example.com";
const STRANGER_EMAIL = "perf-stranger@example.com";

let ownerId: string;
let strangerId: string;

/**
 * Counts the SQL round trips a block issues, by wrapping the shared
 * pool's `query` for the duration. The modules hold the same pool object,
 * so this observes their real calls without touching source or stubbing
 * behavior.
 */
function withQueryCounter(): { stop: () => number } {
  const untypedPool = pool as unknown as {
    query: (...args: unknown[]) => Promise<unknown>;
  };
  const original = pool.query.bind(pool);
  let count = 0;
  untypedPool.query = (...args: unknown[]) => {
    count += 1;
    return (original as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
  };
  return {
    stop: () => {
      untypedPool.query = original as unknown as (...args: unknown[]) => Promise<unknown>;
      return count;
    },
  };
}

async function createTestUser(email: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'Test') RETURNING id`,
    [email],
  );
  return result.rows[0].id;
}

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM users WHERE email IN ($1, $2)`, [OWNER_EMAIL, STRANGER_EMAIL]);
}

beforeEach(async () => {
  await cleanup();
  ownerId = await createTestUser(OWNER_EMAIL);
  strangerId = await createTestUser(STRANGER_EMAIL);
});

afterEach(cleanup);

/** A trip with a known, deliberately uneven set of children. */
async function seedTrip(
  userId: string,
  title: string,
  children: { destinations: number; flights: number; travelers: number },
): Promise<string> {
  const trip = await createTrip(userId, { title });
  for (let index = 0; index < children.destinations; index += 1) {
    await addDestinationToTrip(trip.id, userId, {
      city: `City ${index}`,
      country: "Testland",
      orderIndex: index,
    });
  }
  for (let index = 0; index < children.flights; index += 1) {
    await addFlightToTrip(trip.id, userId, {
      flightNumber: `TS${index}`,
      airline: "Test Air",
      departureAirport: "AAA",
      arrivalAirport: "BBB",
      scheduledDeparture: new Date("2026-12-01T08:00:00Z"),
      scheduledArrival: new Date("2026-12-01T11:00:00Z"),
    });
  }
  for (let index = 0; index < children.travelers; index += 1) {
    await addTravelerToTrip(trip.id, userId, { fullName: `Traveler ${index}` });
  }
  return trip.id;
}

describe("getUserTripEntityCounts", () => {
  it("answers with one query, however many trips the user has", async () => {
    const tripIds: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      tripIds.push(
        await seedTrip(ownerId, `Trip ${index}`, { destinations: 2, flights: 1, travelers: 1 }),
      );
    }
    // A second user's equally sized portfolio exists at the same time, so
    // the scoping predicate is genuinely exercised rather than trivially
    // true (the whole database belonging to one user).
    await seedTrip(strangerId, "Not mine", { destinations: 2, flights: 1, travelers: 1 });

    const counter = withQueryCounter();
    const counts = await getUserTripEntityCounts(ownerId);
    const queries = counter.stop();

    expect(queries).toBe(1);
    expect(counts).toEqual({ trips: 12, destinations: 24, flights: 12, travelers: 12 });
  });

  it("returns the same numbers the per-trip twin loop it replaced produced", async () => {
    await seedTrip(ownerId, "A", { destinations: 2, flights: 3, travelers: 1 });
    await seedTrip(ownerId, "B", { destinations: 1, flights: 0, travelers: 2 });
    await seedTrip(ownerId, "C", { destinations: 0, flights: 0, travelers: 0 });

    const trips = await listUserTrips(ownerId);
    let destinations = 0;
    let flights = 0;
    let travelers = 0;
    for (const trip of trips) {
      const twin = await getTripDigitalTwin(trip.id, ownerId);
      destinations += twin.destinations.length;
      flights += twin.flights.length;
      travelers += twin.travelers.length;
    }

    await expect(getUserTripEntityCounts(ownerId)).resolves.toEqual({
      trips: trips.length,
      destinations,
      flights,
      travelers,
    });
  });

  it("counts only the caller's own trips, never a stranger's children", async () => {
    await seedTrip(ownerId, "Mine", { destinations: 1, flights: 1, travelers: 1 });
    await seedTrip(strangerId, "Theirs", { destinations: 9, flights: 9, travelers: 9 });

    await expect(getUserTripEntityCounts(ownerId)).resolves.toEqual({
      trips: 1,
      destinations: 1,
      flights: 1,
      travelers: 1,
    });
  });

  it("reports zeros — not an error — for an account with no trips yet", async () => {
    await expect(getUserTripEntityCounts(ownerId)).resolves.toEqual({
      trips: 0,
      destinations: 0,
      flights: 0,
      travelers: 0,
    });
  });
});

describe("calculateOperationalState", () => {
  it("costs a fixed number of queries no matter how many flights the trip has", async () => {
    const tripId = await seedTrip(ownerId, "Many flights", {
      destinations: 0,
      flights: 8,
      travelers: 0,
    });

    const counter = withQueryCounter();
    const state = await calculateOperationalState(tripId, ownerId);
    const queries = counter.stop();

    // Ownership check + destinations + flights + one batched snapshot read.
    // Before Phase 29 this was 2 + one query per flight, i.e. 10 here and
    // 24 on a twenty-flight trip. The assertion is on the SHAPE (constant),
    // not on the exact number — adding a genuinely needed read should not
    // require rewriting this test, growing it with flight count should.
    expect(queries).toBe(4);
    expect(state.state).toBe("ON_TRACK");
  });

  it("reads the LATEST snapshot per flight, not merely the first one it finds", async () => {
    const tripId = await seedTrip(ownerId, "Superseded status", {
      destinations: 0,
      flights: 3,
      travelers: 0,
    });
    const twin = await getTripDigitalTwin(tripId, ownerId);
    const [first, second] = twin.flights;

    // A cancelled flight that was later re-scheduled must read as fine:
    // the batch picks the newest row per flight exactly like the per-flight
    // query it replaced, so ordering inside the batch must not leak.
    await insertFlightStatusSnapshot({
      flightRecordId: first.id,
      status: "CANCELLED",
      fetchedAt: new Date("2026-11-20T10:00:00Z"),
    });
    await insertFlightStatusSnapshot({
      flightRecordId: first.id,
      status: "SCHEDULED",
      fetchedAt: new Date("2026-11-20T12:00:00Z"),
    });
    // The second flight is genuinely disrupted, and the third has no
    // snapshot at all — a flight that was never checked contributes
    // nothing rather than being treated as on time.
    await insertFlightStatusSnapshot({
      flightRecordId: second.id,
      status: "DELAYED",
      delayMinutes: 45,
      fetchedAt: new Date("2026-11-20T11:00:00Z"),
    });

    const state = await calculateOperationalState(tripId, ownerId);

    expect(state.state).toBe("ATTENTION_NEEDED");
    // Exactly one factor: the re-scheduled flight is not reported as
    // cancelled, and the never-checked one is silently absent rather than
    // being asserted to be fine.
    expect(state.factors).toEqual([`Flight ${second.flightNumber} is delayed by 45 minutes.`]);
  });
});
