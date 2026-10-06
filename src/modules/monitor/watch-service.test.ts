import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/infrastructure/db";
import {
  addDestinationToTrip,
  addFlightToTrip,
  changeTripStatus,
  createTrip,
  getTripEventHistory,
} from "@/modules/trip/trip-service";
import { countUnreadNotifications } from "@/modules/notification/notification-service";
import { insertFlightStatusSnapshot } from "@/modules/trip/flight-repository";
import { monitorTrip } from "@/modules/monitor/monitor-service";
import {
  MAX_WATCH_INTERVAL_MINUTES,
  MIN_WATCH_INTERVAL_MINUTES,
  countDueWatches,
  getTripWatch,
  listTripWatches,
  runDueWatches,
  upsertTripWatch,
} from "@/modules/monitor/watch-service";
import { NotFoundError, ValidationError } from "@/shared/errors";

/**
 * Real Postgres throughout, for the same reason Phase 18's monitor
 * tests use it: the properties that matter here are database
 * properties. "A watch runs once even if two sweeps race" is only true
 * if the claim UPDATE is genuinely atomic, and a mocked pool would
 * assert nothing about that. It is also where the CHECK constraint on
 * `interval_minutes` actually lives.
 *
 * The provider *adapters* are pinned rather than given a stubbed fetch,
 * because with no API key configured the real factories resolve to
 * documented mocks that always answer "scheduled, clear" — they can
 * never produce the escalation these tests need to drive. Pinning them
 * keeps the real agents in play; only the outside world is made
 * controllable. Same approach as Phase 18 and Phase 15.
 *
 * `monitorTrip` itself is wrapped (not replaced): the default
 * implementation is the real one, so a normal test exercises the whole
 * chain, and one test can `mockRejectedValueOnce` to prove a failed
 * pass is recorded instead of vanishing.
 */
let flightStatus = "scheduled";
let flightDelay = 0;
let weatherCondition = "Clear";
let weatherWind = 8;

vi.mock("@/integrations/aviation/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/integrations/aviation/provider")>();
  return {
    ...actual,
    getAviationProvider: vi.fn(() => ({
      providerName: "test-aviation",
      getFlightStatus: async (flightIata: string) => ({
        flightDate: new Date().toISOString().slice(0, 10),
        flightStatus,
        airline: { name: "Test Airline", iata: "TT" },
        flight: { number: "1353", iata: flightIata },
        departure: {
          airport: "Test Departure",
          iata: "TD",
          scheduled: new Date().toISOString(),
          estimated: null,
          actual: null,
          delayMinutes: flightDelay || null,
          terminal: "1",
          gate: "A1",
        },
        arrival: {
          airport: "Test Arrival",
          iata: "TA",
          scheduled: new Date(Date.now() + 3600_000).toISOString(),
          estimated: null,
          actual: null,
          delayMinutes: flightDelay || null,
          terminal: "2",
          gate: "B2",
        },
      }),
    })),
  };
});

vi.mock("@/integrations/weather/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/integrations/weather/provider")>();
  return {
    ...actual,
    getWeatherProvider: vi.fn(() => ({
      providerName: "test-weather",
      getCurrentWeather: async () => ({
        locationName: "Porto",
        country: "Portugal",
        observationTime: new Date().toISOString(),
        temperatureCelsius: 14,
        windSpeedKph: weatherWind,
        precipitationMm: 0,
        humidity: 60,
        condition: weatherCondition,
      }),
    })),
  };
});

vi.mock("@/modules/monitor/monitor-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/monitor/monitor-service")>();
  return { ...actual, monitorTrip: vi.fn(actual.monitorTrip) };
});

const OWNER_EMAIL = "watch-owner@example.com";
const OTHER_EMAIL = "watch-other@example.com";
let ownerId: string;
let otherId: string;

async function createTestUser(email: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'Test') RETURNING id`,
    [email],
  );
  return result.rows[0].id;
}

/** Points the pinned providers at a new status / reading. */
function providerState(state: {
  flightStatus?: string;
  flightDelay?: number;
  weatherCondition?: string;
  weatherWind?: number;
}) {
  flightStatus = state.flightStatus ?? "scheduled";
  flightDelay = state.flightDelay ?? 0;
  weatherCondition = state.weatherCondition ?? "Clear";
  weatherWind = state.weatherWind ?? 8;
}

async function cleanupTestUsers(): Promise<void> {
  await pool.query(
    `DELETE FROM trip_documents WHERE uploaded_by IN (SELECT id FROM users WHERE email IN ($1, $2))`,
    [OWNER_EMAIL, OTHER_EMAIL],
  );
  // runDueWatches writes a SYSTEM `watch.sweep` audit row per pass (Phase
  // 24), and audit_logs deliberately has no foreign keys — so deleting the
  // users does NOT cascade these away. They are removed explicitly, by
  // entity, owner metadata, and actor, before the users themselves go.
  await pool.query(
    `DELETE FROM audit_logs
      WHERE actor_id IN (SELECT id::text FROM users WHERE email IN ($1, $2))
         OR metadata->>'ownerId' IN (SELECT id::text FROM users WHERE email IN ($1, $2))
         OR entity_id IN (SELECT id FROM trips WHERE user_id IN (SELECT id FROM users WHERE email IN ($1, $2)))`,
    [OWNER_EMAIL, OTHER_EMAIL],
  );
  await pool.query(`DELETE FROM users WHERE email IN ($1, $2)`, [OWNER_EMAIL, OTHER_EMAIL]);
}

/** A trip with one destination and one flight, like Phase 18's fixture. */
async function tripWithFlight(userId: string, title: string) {
  const trip = await createTrip(userId, { title });
  await addDestinationToTrip(trip.id, userId, { city: "Porto", country: "Portugal" });
  const flight = await addFlightToTrip(trip.id, userId, {
    flightNumber: "TP1353",
    airline: "TAP",
    departureAirport: "LIS",
    arrivalAirport: "OPO",
    scheduledDeparture: new Date(Date.now() + 6 * 60 * 60 * 1000),
    scheduledArrival: new Date(Date.now() + 8 * 60 * 60 * 1000),
  });
  return { trip, flight };
}

beforeEach(async () => {
  await cleanupTestUsers();
  providerState({});
  vi.mocked(monitorTrip).mockClear();
  ownerId = await createTestUser(OWNER_EMAIL);
  otherId = await createTestUser(OTHER_EMAIL);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanupTestUsers();
});

describe("upsertTripWatch", () => {
  it("creates a watch with documented defaults, due immediately", async () => {
    const trip = await createTrip(ownerId, { title: "Watch me" });

    const before = Date.now();
    const watch = await upsertTripWatch(trip.id, ownerId, {});

    expect(watch.enabled).toBe(true);
    expect(watch.intervalMinutes).toBe(60);
    expect(watch.alertMinSeverity).toBe("MEDIUM");
    expect(watch.lastRunAt).toBeNull();
    expect(watch.lastError).toBeNull();
    // Enabling a watch makes it due now — "start watching this trip"
    // that does nothing for an hour reads as broken.
    expect(watch.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(watch.nextRunAt.getTime()).toBeGreaterThanOrEqual(before - 1000);

    const read = await getTripWatch(trip.id, ownerId);
    expect(read?.id).toBe(watch.id);
  });

  it("keeps stored preferences when a partial update omits them", async () => {
    const trip = await createTrip(ownerId, { title: "Partial" });
    await upsertTripWatch(trip.id, ownerId, { intervalMinutes: 120, alertMinSeverity: "HIGH" });

    const afterSeverity = await upsertTripWatch(trip.id, ownerId, { enabled: false });

    expect(afterSeverity.intervalMinutes).toBe(120);
    expect(afterSeverity.alertMinSeverity).toBe("HIGH");
    expect(afterSeverity.enabled).toBe(false);
  });

  it("makes the watch due again when it is switched back on", async () => {
    const trip = await createTrip(ownerId, { title: "Paused" });
    const watch = await upsertTripWatch(trip.id, ownerId, { enabled: false });
    // Pretend the paused watch was parked a day out.
    await pool.query(
      `UPDATE trip_watches SET next_run_at = now() + interval '1 day' WHERE id = $1`,
      [watch.id],
    );

    const resumed = await upsertTripWatch(trip.id, ownerId, { enabled: true });

    expect(resumed.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("accepts the documented cadence bounds and rejects anything outside them", async () => {
    const trip = await createTrip(ownerId, { title: "Bounds" });

    const min = await upsertTripWatch(trip.id, ownerId, {
      intervalMinutes: MIN_WATCH_INTERVAL_MINUTES,
    });
    const max = await upsertTripWatch(trip.id, ownerId, {
      intervalMinutes: MAX_WATCH_INTERVAL_MINUTES,
    });
    expect(min.intervalMinutes).toBe(MIN_WATCH_INTERVAL_MINUTES);
    expect(max.intervalMinutes).toBe(MAX_WATCH_INTERVAL_MINUTES);

    // A cadence of zero would be a tight loop against paid provider APIs,
    // so this is rejected in code *and* by a CHECK constraint on the table.
    await expect(upsertTripWatch(trip.id, ownerId, { intervalMinutes: 1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      upsertTripWatch(trip.id, ownerId, { intervalMinutes: MAX_WATCH_INTERVAL_MINUTES + 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("treats a stranger's trip exactly like a missing one", async () => {
    const trip = await createTrip(ownerId, { title: "Private" });

    await expect(upsertTripWatch(trip.id, otherId, {})).rejects.toBeInstanceOf(NotFoundError);
    await expect(getTripWatch(trip.id, otherId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await getTripWatch(trip.id, ownerId)).toBeNull();
  });

  it("lists only the caller's own watches", async () => {
    const mine = await createTrip(ownerId, { title: "Mine" });
    const alsoMine = await createTrip(ownerId, { title: "Also mine" });
    const theirs = await createTrip(otherId, { title: "Theirs" });
    await upsertTripWatch(mine.id, ownerId, {});
    await upsertTripWatch(alsoMine.id, ownerId, {});
    await upsertTripWatch(theirs.id, otherId, {});

    const watches = await listTripWatches(ownerId);

    expect(watches).toHaveLength(2);
    expect(watches.map((watch) => watch.tripTitle).sort()).toEqual(["Also mine", "Mine"]);
  });
});

describe("runDueWatches", () => {
  it("runs a due watch, records the pass, and schedules the next one an interval out", async () => {
    const { trip } = await tripWithFlight(ownerId, "Due now");
    await upsertTripWatch(trip.id, ownerId, { intervalMinutes: 15 });

    const sweep = await runDueWatches({ ownerId });

    expect(sweep.passes).toHaveLength(1);
    expect(sweep.passes[0].outcome).toBe("ran");
    expect(sweep.passes[0].monitor).not.toBeNull();
    expect(sweep.passes[0].monitor!.checkedFlights).toHaveLength(1);
    expect(sweep.stillDue).toBe(0);

    const watch = await getTripWatch(trip.id, ownerId);
    expect(watch!.lastRunAt).not.toBeNull();
    expect(watch!.lastError).toBeNull();

    // The schedule advances by exactly the configured cadence, measured
    // from the pass itself.
    const gapMinutes = (watch!.nextRunAt.getTime() - watch!.lastRunAt!.getTime()) / 60_000;
    expect(gapMinutes).toBeGreaterThan(14.5);
    expect(gapMinutes).toBeLessThan(15.5);
  });

  it("runs nothing when the watch is paused or not yet due", async () => {
    const { trip } = await tripWithFlight(ownerId, "Not due");
    await upsertTripWatch(trip.id, ownerId, { enabled: false });

    const paused = await runDueWatches({ ownerId });
    expect(paused.passes).toHaveLength(0);
    expect(await countDueWatches({ ownerId })).toBe(0);

    await upsertTripWatch(trip.id, ownerId, { enabled: true });
    // Due now — move it a day out, as a scheduler would after a run.
    await pool.query(
      `UPDATE trip_watches SET next_run_at = now() + interval '1 day' WHERE trip_id = $1`,
      [trip.id],
    );

    const later = await runDueWatches({ ownerId });
    expect(later.passes).toHaveLength(0);
    expect(await countDueWatches({ ownerId })).toBe(0);
  });

  it("runs a due watch exactly once when two sweeps race", async () => {
    const { trip } = await tripWithFlight(ownerId, "Raced");
    await upsertTripWatch(trip.id, ownerId, {});

    const [first, second] = await Promise.all([
      runDueWatches({ ownerId }),
      runDueWatches({ ownerId }),
    ]);

    const ran = [...first.passes, ...second.passes].filter((pass) => pass.outcome === "ran");
    expect(ran).toHaveLength(1);
    // The loser either never saw it as due or lost the claim — never a
    // second monitoring pass against the provider.
    expect(vi.mocked(monitorTrip)).toHaveBeenCalledTimes(1);
    // Claimed forward by the winner, so the raced watch is not due again.
    expect(await countDueWatches({ ownerId })).toBe(0);
    expect((await getTripWatch(trip.id, ownerId))!.lastRunAt).not.toBeNull();
  });

  it("records a failed pass in last_error and does not retry it immediately", async () => {
    const { trip } = await tripWithFlight(ownerId, "Failing");
    await upsertTripWatch(trip.id, ownerId, { intervalMinutes: 15 });
    vi.mocked(monitorTrip).mockRejectedValueOnce(new Error("provider meltdown"));

    const sweep = await runDueWatches({ ownerId });

    expect(sweep.passes[0].outcome).toBe("failed");
    expect(sweep.passes[0].error).toContain("provider meltdown");
    expect(sweep.failed).toBe(1);

    const watch = await getTripWatch(trip.id, ownerId);
    expect(watch!.lastError).toContain("provider meltdown");
    // Claimed forward, not left due — a broken provider must not turn
    // into a hot loop.
    expect(watch!.nextRunAt.getTime()).toBeGreaterThan(Date.now());

    const again = await runDueWatches({ ownerId });
    expect(again.passes).toHaveLength(0);
  });

  it("clears a previous failure once a pass succeeds", async () => {
    const { trip } = await tripWithFlight(ownerId, "Recovering");
    await upsertTripWatch(trip.id, ownerId, { intervalMinutes: 15 });
    vi.mocked(monitorTrip).mockRejectedValueOnce(new Error("provider meltdown"));
    await runDueWatches({ ownerId });

    // Run the clock forward instead of touching the row: the sweep's
    // `now` is injectable precisely so the schedule can be tested
    // without waiting for it.
    const later = new Date(Date.now() + 16 * 60_000);
    const sweep = await runDueWatches({ ownerId, now: later });

    expect(sweep.passes[0].outcome).toBe("ran");
    const watch = await getTripWatch(trip.id, ownerId);
    expect(watch!.lastError).toBeNull();
  });

  it("honours the watch's alert floor: no notification below it, but the assessment is still recorded", async () => {
    const { trip, flight } = await tripWithFlight(ownerId, "Quiet");
    await insertFlightStatusSnapshot({
      flightRecordId: flight.id,
      status: "SCHEDULED",
      fetchedAt: new Date(Date.now() - 60_000),
    });
    // Baseline pass, so the weather shift below is a genuine change.
    await monitorTrip(trip.id, ownerId);
    providerState({ weatherWind: 60 });
    await upsertTripWatch(trip.id, ownerId, { alertMinSeverity: "CRITICAL" });

    const sweep = await runDueWatches({ ownerId });

    expect(sweep.passes[0].outcome).toBe("ran");
    expect(sweep.passes[0].monitor!.riskChange!.severity).toBe("HIGH");
    expect(sweep.passes[0].monitor!.alert).toBeNull();
    expect(sweep.passes[0].monitor!.alertSuppressionReason).toBe("below-threshold");
    expect(sweep.alertsRaised).toBe(0);
    expect(await countUnreadNotifications(ownerId)).toBe(0);

    const stored = await pool.query<{ severity: string }>(
      `SELECT severity::text AS severity FROM risk_assessments
        WHERE trip_id = $1 ORDER BY generated_at DESC LIMIT 1`,
      [trip.id],
    );
    expect(stored.rows[0].severity).toBe("HIGH");
  });

  it("notifies when the change is at or above the watch's floor", async () => {
    const { trip, flight } = await tripWithFlight(ownerId, "Loud");
    await insertFlightStatusSnapshot({
      flightRecordId: flight.id,
      status: "SCHEDULED",
      fetchedAt: new Date(Date.now() - 60_000),
    });
    await monitorTrip(trip.id, ownerId);
    providerState({ weatherWind: 60 });
    await upsertTripWatch(trip.id, ownerId, { alertMinSeverity: "HIGH" });

    const sweep = await runDueWatches({ ownerId });

    expect(sweep.passes[0].monitor!.alert).not.toBeNull();
    expect(sweep.passes[0].monitor!.alertSuppressionReason).toBeNull();
    expect(sweep.alertsRaised).toBe(1);
    expect(await countUnreadNotifications(ownerId)).toBe(1);
  });

  it("stops watching a trip that is already finished, and says so in the event history", async () => {
    const { trip } = await tripWithFlight(ownerId, "Finished");
    await upsertTripWatch(trip.id, ownerId, {});
    await changeTripStatus(trip.id, ownerId, "COMPLETED");

    const sweep = await runDueWatches({ ownerId });

    expect(sweep.passes[0].outcome).toBe("finished");
    expect(sweep.finished).toBe(1);
    expect(vi.mocked(monitorTrip)).not.toHaveBeenCalled();

    const watch = await getTripWatch(trip.id, ownerId);
    expect(watch!.enabled).toBe(false);

    const events = await getTripEventHistory(trip.id, ownerId);
    expect(events.some((event) => event.eventType === "WATCH_PAUSED")).toBe(true);

    // Idempotent: the same fact is not recorded twice even if the sweep
    // runs again while the trip is still finished.
    const again = await runDueWatches({ ownerId });
    expect(again.passes).toHaveLength(0);
    const pausedEvents = (await getTripEventHistory(trip.id, ownerId)).filter(
      (event) => event.eventType === "WATCH_PAUSED",
    );
    expect(pausedEvents).toHaveLength(1);
  });

  it("only touches the watches of the user it was scoped to", async () => {
    const mine = await tripWithFlight(ownerId, "My trip");
    const theirs = await tripWithFlight(otherId, "Their trip");
    await upsertTripWatch(mine.trip.id, ownerId, {});
    await upsertTripWatch(theirs.trip.id, otherId, {});

    const sweep = await runDueWatches({ ownerId });

    expect(sweep.passes.map((pass) => pass.tripId)).toEqual([mine.trip.id]);
    expect(await getTripWatch(theirs.trip.id, otherId)).toMatchObject({ lastRunAt: null });
    // The other user's watch is still due — untouched, not swallowed.
    expect(await countDueWatches({ ownerId: otherId })).toBe(1);
    expect(await countDueWatches({})).toBe(1);
  });

  it("reports but does not run work beyond its limit", async () => {
    for (const title of ["One", "Two", "Three"]) {
      const { trip } = await tripWithFlight(ownerId, title);
      await upsertTripWatch(trip.id, ownerId, {});
    }

    expect(await countDueWatches({ ownerId })).toBe(3);

    const sweep = await runDueWatches({ ownerId, limit: 2 });

    expect(sweep.passes).toHaveLength(2);
    expect(sweep.stillDue).toBe(1);
  });
});
