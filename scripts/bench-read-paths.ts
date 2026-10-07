/**
 * Phase 29 measurement harness — the real read paths the pages call,
 * measured against a seeded dataset, with the SQL round-trip count
 * recorded alongside the wall clock.
 *
 * Why a script and not a test: it seeds and deletes hundreds of rows to
 * get a representative dataset, which would make the shared suite slow
 * and stateful. It runs against the TEST database only (never dev), and
 * cleans up after itself.
 *
 *   TEST_DATABASE_URL=... pnpm tsx scripts/bench-read-paths.ts
 *
 * The query count matters as much as the milliseconds here: this code's
 * failure mode is not a slow query, it is doing the same query once per
 * trip (see the analytics page in the Phase 29 entry of
 * docs/BUILD_PROGRESS.md).
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:devpassword@localhost:5432/tripos_test";

// Set before anything imports config/env: this script must never be able
// to run against the development database by accident. NODE_ENV=test
// keeps the logger silent so the output is only the measurements.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";
process.env.AUTH_SECRET ??= "bench-secret-at-least-32-characters-long-00";
// Assigned through Object.assign: @types/node declares NODE_ENV read-only.
Object.assign(process.env, { NODE_ENV: "test" });

const BENCH_EMAIL = "phase29-bench@example.com";

interface Measurement {
  label: string;
  queries: number;
  medianMs: number;
  trips: number;
}

async function main(): Promise<void> {
  const { pool } = await import("@/infrastructure/db");
  const {
    listUserTrips,
    getTripDigitalTwin,
    addDestinationToTrip,
    addFlightToTrip,
    addTravelerToTrip,
    emitTripEvent,
    calculateOperationalState,
    getUserTripEntityCounts,
  } = await import("@/modules/trip/trip-service");
  const { getUserAuditTrail, recordUserAction } = await import("@/modules/audit/audit-service");
  const { getTripEventHistory } = await import("@/modules/trip/trip-service");
  const { getTripIndexStatus } = await import("@/modules/trip/rag-service");
  const { getLatestTripRisk } = await import("@/modules/risk/risk-service");
  const { listTripRecommendations } = await import("@/modules/risk/recommendation-service");
  const { getTripWatch } = await import("@/modules/monitor/watch-service");
  const { getTripAuditTrail } = await import("@/modules/audit/audit-service");

  // --- Query counting ---------------------------------------------------
  // The modules hold a reference to this same pool object, so patching the
  // method observes every query they issue without touching the source.
  let queries = 0;
  const originalQuery = pool.query.bind(pool);
  const untypedPool = pool as unknown as {
    query: (...args: unknown[]) => Promise<unknown>;
  };
  untypedPool.query = (...args: unknown[]) => {
    queries += 1;
    return (originalQuery as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
  };
  const startCount = (): (() => number) => {
    queries = 0;
    return () => queries;
  };

  await cleanup(pool);

  const userResult = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'Bench') RETURNING id`,
    [BENCH_EMAIL],
  );
  const userId = userResult.rows[0].id;

  const tripCount = Number(process.env.BENCH_TRIPS ?? 40);
  const progress = (message: string): void => {
    if (process.env.BENCH_VERBOSE) console.error(`[bench] ${message}`);
  };
  const perTrip = { destinations: 3, flights: 4, travelers: 2, events: 6, audits: 3 };

  const tripIds: string[] = [];
  for (let index = 0; index < tripCount; index += 1) {
    if (index % 10 === 0) progress(`seeding trip ${index + 1}/${tripCount}`);
    const trip = await pool.query<{ id: string }>(
      `INSERT INTO trips (user_id, title, status) VALUES ($1, $2, 'PLANNING') RETURNING id`,
      [userId, `Bench trip ${index}`],
    );
    const tripId = trip.rows[0].id;
    tripIds.push(tripId);

    for (let destination = 0; destination < perTrip.destinations; destination += 1) {
      await addDestinationToTrip(tripId, userId, {
        city: `City ${destination}`,
        country: "Testland",
        orderIndex: destination,
      });
    }
    for (let flight = 0; flight < perTrip.flights; flight += 1) {
      await addFlightToTrip(tripId, userId, {
        flightNumber: `TS${flight}00`,
        airline: "Test Air",
        departureAirport: "AAA",
        arrivalAirport: "BBB",
        scheduledDeparture: new Date("2026-11-01T08:00:00Z"),
        scheduledArrival: new Date("2026-11-01T11:00:00Z"),
      });
    }
    for (let traveler = 0; traveler < perTrip.travelers; traveler += 1) {
      await addTravelerToTrip(tripId, userId, { fullName: `Traveler ${traveler}` });
    }
    for (let event = 0; event < perTrip.events; event += 1) {
      await emitTripEvent(tripId, userId, {
        eventType: "BENCH_EVENT",
        entityType: "trip",
        entityId: tripId,
        metadata: { seq: event },
      });
    }
    for (let audit = 0; audit < perTrip.audits; audit += 1) {
      recordUserAction({
        requestId: `req_bench-${index}-${audit}`,
        userId,
        action: "trip.update",
        entityType: "trip",
        entityId: tripId,
        metadata: { tripId, userId, seq: audit },
      });
    }
  }

  // recordUserAction is fire-and-forget by contract; wait for the rows to
  // actually land so the audit-path measurement reads a full dataset.
  const expectedAudits = tripCount * perTrip.audits;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const landed = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_logs WHERE actor_id = $1`,
      [userId],
    );
    if (landed.rows[0].count >= expectedAudits) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  progress("seed complete");
  const trips = await listUserTrips(userId);
  const firstTripId = trips[0].id;

  const measurements: Measurement[] = [];

  // 1. Trips dashboard — what /trips actually awaits.
  measurements.push(
    await measure("GET /trips (dashboard)", startCount, 3, async () => {
      const rows = await listUserTrips(userId);
      return rows.length;
    }),
  );

  // 2. Trip detail — one trip's full digital twin.
  measurements.push(
    await measure("GET /trips/[id] (one twin)", startCount, 3, async () => {
      const twin = await getTripDigitalTwin(firstTripId, userId);
      return twin.destinations.length + twin.flights.length + twin.travelers.length;
    }),
  );

  // 3. Trip detail — the operational-state half, alone.
  measurements.push(
    await measure("operational state (one trip)", startCount, 3, async () => {
      const state = await calculateOperationalState(firstTripId, userId);
      return state.factors.length;
    }),
  );

  // 4. Analytics — the shape that shipped before Phase 29: one digital twin
  //    per trip, adding up array lengths. Kept in the harness so the
  //    comparison is measured in the same run, on the same dataset.
  measurements.push(
    await measure("analytics BEFORE (per-trip loop)", startCount, 3, async () => {
      let total = 0;
      for (const trip of trips) {
        const twin = await getTripDigitalTwin(trip.id, userId);
        total += twin.destinations.length + twin.flights.length + twin.travelers.length;
      }
      return total;
    }),
  );

  // 5. Analytics — the shipped shape after Phase 29: one aggregate query.
  measurements.push(
    await measure("analytics AFTER (aggregate)", startCount, 3, async () => {
      const counts = await getUserTripEntityCounts(userId);
      return counts.destinations + counts.flights + counts.travelers;
    }),
  );

  // 6. Trip detail — the eight independent loads the page awaits, in the
  //    order the page awaits them.
  //
  //    The same loads wrapped in one `Promise.all` were measured here too,
  //    at 24 queries and 26.6 ms median against 9.1 ms sequentially —
  //    SLOWER, because this box runs Postgres locally (so there is no
  //    round-trip latency to overlap) on a single CPU. That is why the page
  //    still awaits them in sequence; re-add the parallel variant and
  //    re-measure before believing the theory.
  measurements.push(
    await measure("GET /trips/[id] (page loads)", startCount, 3, async () => {
      const twin = await getTripDigitalTwin(firstTripId, userId);
      await getTripEventHistory(firstTripId, userId);
      await getTripIndexStatus(firstTripId, userId);
      await getLatestTripRisk(firstTripId, userId);
      await listTripRecommendations(firstTripId, userId);
      await getTripWatch(firstTripId, userId);
      await getTripAuditTrail(firstTripId, userId, { limit: 8 });
      return twin.flights.length;
    }),
  );

  // 7. Audit page — the stream the user sees.
  measurements.push(
    await measure("GET /trips/audit (stream)", startCount, 3, async () => {
      const page = await getUserAuditTrail(userId);
      return page.entries.length;
    }),
  );

  console.log(`\nseeded: ${tripCount} trips, per trip ${JSON.stringify(perTrip)}\n`);
  console.log(["path", "queries", "median ms", "queries/trip"].map((h) => h.padEnd(18)).join(""));
  for (const m of measurements) {
    console.log(
      [
        m.label.padEnd(18),
        String(m.queries).padEnd(18),
        m.medianMs.toFixed(1).padEnd(18),
        (m.queries / m.trips).toFixed(2),
      ].join(""),
    );
  }

  await cleanup(pool);
  await pool.end();
  console.log("\ncleaned up.");
}

async function measure(
  label: string,
  startCount: () => () => number,
  reps: number,
  run: () => Promise<number>,
): Promise<Measurement> {
  const { pool } = await import("@/infrastructure/db");
  const totalTrips = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM trips t JOIN users u ON u.id = t.user_id WHERE u.email = $1`,
    [BENCH_EMAIL],
  );

  console.error(`[bench] measuring ${label}`);
  const durations: number[] = [];
  let queryCount = 0;
  for (let rep = 0; rep < reps; rep += 1) {
    const stop = startCount();
    const started = performance.now();
    await run();
    durations.push(performance.now() - started);
    queryCount = stop();
  }
  durations.sort((a, b) => a - b);
  return {
    label,
    queries: queryCount,
    medianMs: durations[Math.floor(durations.length / 2)],
    trips: totalTrips.rows[0].count,
  };
}

async function cleanup(pool: {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
}): Promise<void> {
  const existing = (await pool.query(`SELECT id FROM users WHERE email = $1`, [BENCH_EMAIL])) as {
    rows: Array<{ id: string }>;
  };
  for (const row of existing.rows) {
    // audit_logs deliberately has no FK to users, so it does not cascade.
    await pool.query(`DELETE FROM audit_logs WHERE actor_id = $1`, [row.id]);
    await pool.query(`DELETE FROM audit_logs WHERE metadata->>'userId' = $1`, [row.id]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [row.id]);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
