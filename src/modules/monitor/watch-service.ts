import { pool } from "@/infrastructure/db";
import { ValidationError } from "@/shared/errors";
import { emitTripEvent, getTrip } from "@/modules/trip/trip-service";
import { type RiskSeverity } from "@/modules/risk/risk-repository";
import { monitorTrip, type MonitorRunResult } from "@/modules/monitor/monitor-service";
import { recordSystemAction } from "@/modules/audit/audit-service";

/**
 * Trip Watch — Phase 19, the scheduling half of the monitor.
 *
 * Phase 18 built `monitorTrip()`: one honest pass, idempotent, safe to
 * call twice. What it deliberately did not have was any idea of *when* a
 * pass should happen. This file is that idea, and nothing else: which
 * trips are watched, how often, what the traveler is willing to be
 * interrupted for, and whether a watch is due.
 *
 * Three properties are the point of the design:
 *
 *  1. **Claim-then-run, in one statement.** A sweep does not "check if
 *     due, then run" — that is a race. It advances `next_run_at` with an
 *     `UPDATE ... WHERE enabled AND next_run_at <= now()` and *only*
 *     runs the pass if that UPDATE actually claimed the row. Two
 *     sweeps racing each other (a cron and a button click, say) produce
 *     exactly one pass per due watch, because Postgres, not application
 *     logic, decides the winner.
 *  2. **A failed pass is recorded, not retried forever.** The claim
 *     already moved the schedule forward, so a failure means "next
 *     attempt one interval later, with `last_error` saying what
 *     happened" — never a hot loop against a broken provider.
 *  3. **Finishing is a reason to stop.** A COMPLETED or CANCELLED trip
 *     has no live flights or weather to watch; the sweep disables that
 *     watch and says so in the trip's own event history, instead of
 *     silently polling a finished trip forever.
 *
 * There is still no BullMQ worker, for the reason Phase 18 documented: a
 * durable queue needs a long-running process, and a Next.js route
 * handler is not one. What this phase can honestly provide is a sweep
 * that is *safe to call from anywhere, any number of times*, so the day
 * a real scheduler exists it is a one-line dispatch, not a redesign.
 * `runDueWatches({ ownerId })` serves the authenticated case that exists
 * today (a user pressing "run due checks"); calling it with no owner
 * runs the global sweep a cron would run, and is deliberately not
 * reachable over HTTP without a session.
 */

/** Default cadence: hourly. Cheap enough to leave on, frequent enough to matter. */
export const DEFAULT_WATCH_INTERVAL_MINUTES = 60;

/**
 * Cadence bounds. The floor exists because every pass makes real,
 * billable provider calls; the ceiling because a watch checked once a
 * day is not watching anything. Enforced here *and* by a CHECK
 * constraint on the table, since a cadence of 0 would be a tight loop
 * against paid APIs — see prisma/sql/phase-19-trip-watch.sql.
 */
export const MIN_WATCH_INTERVAL_MINUTES = 5;
export const MAX_WATCH_INTERVAL_MINUTES = 24 * 60;

/** How many due watches one sweep will run before reporting the rest. */
export const DEFAULT_SWEEP_LIMIT = 5;

const SEVERITY_ORDER: RiskSeverity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export interface TripWatchRecord {
  id: string;
  tripId: string;
  enabled: boolean;
  intervalMinutes: number;
  alertMinSeverity: RiskSeverity;
  lastRunAt: Date | null;
  lastError: string | null;
  nextRunAt: Date;
  /**
   * Whether this watch is due, decided by the database at read time.
   *
   * Derived rather than computed by callers so the answer comes from the
   * clock that owns `next_run_at`, and so a server component can render
   * "due now" without reading a clock mid-render.
   */
  due: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface WatchRow {
  id: string;
  trip_id: string;
  enabled: boolean;
  interval_minutes: number;
  alert_min_severity: RiskSeverity;
  last_run_at: Date | null;
  last_error: string | null;
  next_run_at: Date;
  due: boolean;
  created_at: Date;
  updated_at: Date;
}

function toWatch(row: WatchRow): TripWatchRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    enabled: row.enabled,
    intervalMinutes: row.interval_minutes,
    alertMinSeverity: row.alert_min_severity,
    lastRunAt: row.last_run_at,
    lastError: row.last_error,
    nextRunAt: row.next_run_at,
    due: row.due,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const WATCH_FIELDS = [
  "id",
  "trip_id",
  "enabled",
  "interval_minutes",
  "alert_min_severity",
  "last_run_at",
  "last_error",
  "next_run_at",
  "created_at",
  "updated_at",
] as const;

/**
 * Same column list everywhere, so `toWatch` can rely on the row shape.
 * `due` is computed by Postgres alongside the columns (see the note on
 * `SweepInstant`), never by comparing timestamps in JavaScript.
 */
function watchColumns(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  const fields = WATCH_FIELDS.map((field) => `${prefix}${field}`).join(", ");
  return `${fields}, ${prefix}next_run_at <= now() AS due`;
}

/**
 * The watch for one trip, or null when nobody has started watching it.
 *
 * Ownership is checked first, so a stranger's trip is indistinguishable
 * from one that doesn't exist — the same NotFoundError either way, as
 * everywhere else in this codebase.
 */
export async function getTripWatch(
  tripId: string,
  userId: string,
): Promise<TripWatchRecord | null> {
  await getTrip(tripId, userId);
  const result = await pool.query<WatchRow>(
    `SELECT ${watchColumns()} FROM trip_watches WHERE trip_id = $1`,
    [tripId],
  );
  return result.rows[0] ? toWatch(result.rows[0]) : null;
}

/**
 * Creates or updates a trip's watch. Partial input: omitted fields keep
 * their stored value (or the documented default on first insert), so a
 * caller changing only the cadence cannot accidentally re-enable a
 * paused watch.
 *
 * **Enabling — or re-enabling — makes the watch due immediately.** The
 * alternative (schedule `interval` minutes from now) would make "start
 * watching this trip" do nothing observable for an hour, which reads as
 * broken. Every pass after that schedules the next one a full interval
 * out; that rule lives in the claim below, so it holds no matter who
 * triggered the pass.
 */
export async function upsertTripWatch(
  tripId: string,
  userId: string,
  input: {
    enabled?: boolean;
    intervalMinutes?: number;
    alertMinSeverity?: RiskSeverity;
  },
): Promise<TripWatchRecord> {
  await getTrip(tripId, userId);

  if (input.intervalMinutes !== undefined) {
    if (
      !Number.isInteger(input.intervalMinutes) ||
      input.intervalMinutes < MIN_WATCH_INTERVAL_MINUTES ||
      input.intervalMinutes > MAX_WATCH_INTERVAL_MINUTES
    ) {
      throw new ValidationError(
        `intervalMinutes must be a whole number between ${MIN_WATCH_INTERVAL_MINUTES} and ${MAX_WATCH_INTERVAL_MINUTES}.`,
      );
    }
  }
  if (input.alertMinSeverity !== undefined && !SEVERITY_ORDER.includes(input.alertMinSeverity)) {
    throw new ValidationError(`alertMinSeverity must be one of ${SEVERITY_ORDER.join(", ")}.`);
  }

  // One statement, so two concurrent preference updates cannot interleave
  // into a row that mixes both. Nulls mean "leave as-is".
  const result = await pool.query<WatchRow>(
    `INSERT INTO trip_watches (trip_id, enabled, interval_minutes, alert_min_severity, next_run_at)
     VALUES (
       $1,
       COALESCE($2::boolean, true),
       COALESCE($3::int, ${DEFAULT_WATCH_INTERVAL_MINUTES}),
       COALESCE($4::"RiskSeverity", 'MEDIUM'::"RiskSeverity"),
       now()
     )
     ON CONFLICT (trip_id) DO UPDATE SET
       enabled = COALESCE($2::boolean, trip_watches.enabled),
       interval_minutes = COALESCE($3::int, trip_watches.interval_minutes),
       alert_min_severity = COALESCE($4::"RiskSeverity", trip_watches.alert_min_severity),
       -- Due now when the watch is being switched back on; otherwise the
       -- existing schedule stands.
       next_run_at = CASE
         WHEN COALESCE($2::boolean, trip_watches.enabled) AND NOT trip_watches.enabled
           THEN now()
         ELSE trip_watches.next_run_at
       END,
       updated_at = now()
     RETURNING ${watchColumns()}`,
    [tripId, input.enabled ?? null, input.intervalMinutes ?? null, input.alertMinSeverity ?? null],
  );

  return toWatch(result.rows[0]);
}

/**
 * Atomically takes ownership of a due watch, or returns null if there is
 * nothing to take (not enabled, not due, or another sweep got there
 * first).
 *
 * Advancing the schedule in the same statement that reads it is what
 * makes concurrency safe: the `WHERE` is evaluated by Postgres under row
 * lock, so of two racing sweeps exactly one sees a row to update. The
 * loser gets null and simply moves on.
 */
async function claimDueWatch(tripId: string, now: SweepInstant): Promise<TripWatchRecord | null> {
  const result = await pool.query<WatchRow>(
    `UPDATE trip_watches
        SET next_run_at = COALESCE($2::timestamptz, now()) + make_interval(mins => interval_minutes),
            updated_at = now()
      WHERE trip_id = $1
        AND enabled
        AND next_run_at <= COALESCE($2::timestamptz, now())
      RETURNING ${watchColumns()}`,
    [tripId, now],
  );
  return result.rows[0] ? toWatch(result.rows[0]) : null;
}

/** Records how the pass that claimed this watch actually went. */
async function recordWatchRun(
  watchId: string,
  input: { runAt: SweepInstant; error: string | null },
): Promise<void> {
  await pool.query(
    `UPDATE trip_watches
        SET last_run_at = COALESCE($2::timestamptz, now()), last_error = $3, updated_at = now()
      WHERE id = $1`,
    [watchId, input.runAt, input.error],
  );
}

/** Stops watching a trip the scheduler itself has decided is over. */
async function disableFinishedWatch(watchId: string): Promise<void> {
  await pool.query(`UPDATE trip_watches SET enabled = false, updated_at = now() WHERE id = $1`, [
    watchId,
  ]);
}

interface DueWatchCandidate {
  trip_id: string;
  user_id: string;
  title: string;
  status: string;
}

async function listDueWatchCandidates(input: {
  ownerId?: string;
  now: SweepInstant;
  limit: number;
}): Promise<DueWatchCandidate[]> {
  const result = await pool.query<DueWatchCandidate>(
    `SELECT w.trip_id, t.user_id, t.title, t.status::text AS status
       FROM trip_watches w
       JOIN trips t ON t.id = w.trip_id
      WHERE w.enabled
        AND w.next_run_at <= COALESCE($1::timestamptz, now())
        AND ($2::text IS NULL OR t.user_id = $2::text)
      ORDER BY w.next_run_at ASC
      LIMIT $3`,
    [input.now, input.ownerId ?? null, input.limit],
  );
  return result.rows;
}

/**
 * The clock the scheduler runs on — and a real bug this phase's tests
 * caught, twice over.
 *
 * `next_run_at` is written with Postgres's `now()`, which has
 * microsecond precision, while a JavaScript `Date` does not. So
 * "is this watch due?" cannot be answered by reading the database clock
 * into a Date and comparing in JS: the round trip truncates the
 * microseconds *downwards*, and a watch created moments earlier compares
 * as not-yet-due against a clock that is nominally the same but
 * actually earlier. The first version did exactly that and flaked only
 * under load, which is the worst way for a scheduler to be wrong.
 *
 * The fix is to keep the comparison where the timestamp lives: every
 * query compares against `COALESCE($n::timestamptz, now())`, so the
 * default path never leaves the database, and the injectable `now`
 * (used by tests to move time forward) still works when given.
 */
export type SweepInstant = Date | null;

/** The database's clock, for reporting rather than for comparisons. */
async function databaseNow(): Promise<Date> {
  const result = await pool.query<{ now: Date }>(`SELECT now() AS now`);
  return result.rows[0].now;
}

/** How many enabled watches are due (optionally for one user). */
export async function countDueWatches(
  input: {
    ownerId?: string;
    now?: SweepInstant;
  } = {},
): Promise<number> {
  const now = input.now ?? null;
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM trip_watches w
       JOIN trips t ON t.id = w.trip_id
      WHERE w.enabled
        AND w.next_run_at <= COALESCE($1::timestamptz, now())
        AND ($2::text IS NULL OR t.user_id = $2::text)`,
    [now, input.ownerId ?? null],
  );
  return result.rows[0].count;
}

/** A watch plus the trip it belongs to, for the watch console. */
export interface TripWatchSummary extends TripWatchRecord {
  tripTitle: string;
  tripStatus: string;
}

/**
 * Every watch belonging to one user, soonest-due first.
 *
 * Joins through `trips` rather than storing an owner id on the watch, so
 * ownership cannot drift from the trip's own — the same reason Phase 18
 * reads the owner from the trip instead of duplicating it.
 */
export async function listTripWatches(userId: string): Promise<TripWatchSummary[]> {
  const result = await pool.query<WatchRow & { trip_title: string; trip_status: string }>(
    `SELECT ${watchColumns("w")},
            t.title AS trip_title, t.status::text AS trip_status
       FROM trip_watches w
       JOIN trips t ON t.id = w.trip_id
      WHERE t.user_id = $1
      ORDER BY w.enabled DESC, w.next_run_at ASC`,
    [userId],
  );

  return result.rows.map((row) => ({
    ...toWatch(row),
    tripTitle: row.trip_title,
    tripStatus: row.trip_status,
  }));
}

/**
 * `ran` — a monitor pass completed.
 * `failed` — the pass threw; recorded in `last_error`, next attempt one
 *            interval later.
 * `finished` — the trip is COMPLETED or CANCELLED, so watching stopped.
 * `already-claimed` — another sweep got this watch first; nothing ran
 *            here, and nothing was written.
 */
export type WatchPassOutcomeKind = "ran" | "failed" | "finished" | "already-claimed";

export interface WatchPassOutcome {
  tripId: string;
  tripTitle: string;
  outcome: WatchPassOutcomeKind;
  error: string | null;
  monitor: MonitorRunResult | null;
}

export interface WatchSweepResult {
  /** ISO timestamp this sweep evaluated "due" against — reported, never assumed. */
  now: string;
  passes: WatchPassOutcome[];
  alertsRaised: number;
  failed: number;
  finished: number;
  /** Due watches the limit left for the next sweep. */
  stillDue: number;
}

/**
 * Runs every watch that is due, oldest-due first.
 *
 * Sequential on purpose: each pass makes real provider calls, and
 * running a user's whole travel portfolio in parallel is exactly how a
 * small provider quota turns into a burst of 429s. The service is
 * idempotent, so an interrupted sweep is safe to repeat — anything it
 * already claimed is scheduled forward and will not run twice.
 */
export async function runDueWatches(
  options: {
    /** Omit for the global sweep a scheduler would run. */
    ownerId?: string;
    /** Omit to use the database's clock. */
    now?: Date;
    limit?: number;
    /**
     * Request id to stamp on the SYSTEM audit entries this sweep writes
     * (Phase 24). The sweep is triggered by an HTTP request today, so it
     * has a real request id to correlate its audit rows with; a future
     * cron worker would omit this and get null — the schema's own
     * convention for "no request produced this action".
     */
    auditRequestId?: string;
  } = {},
): Promise<WatchSweepResult> {
  // null = "evaluate due-ness against the database's own clock", which is
  // what the timestamps were written with. A caller-supplied instant
  // (tests moving time forward, or a scheduler replaying a window) is
  // used verbatim.
  const now = options.now ?? null;
  const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;

  const candidates = await listDueWatchCandidates({
    ownerId: options.ownerId,
    now,
    limit,
  });

  const passes: WatchPassOutcome[] = [];

  for (const candidate of candidates) {
    const claimed = await claimDueWatch(candidate.trip_id, now);
    if (!claimed) {
      // Another sweep claimed it between the SELECT and here. Reporting
      // it is more honest than silently dropping it.
      passes.push({
        tripId: candidate.trip_id,
        tripTitle: candidate.title,
        outcome: "already-claimed",
        error: null,
        monitor: null,
      });
      continue;
    }

    if (candidate.status === "COMPLETED" || candidate.status === "CANCELLED") {
      await disableFinishedWatch(claimed.id);
      // The trip's own event history is where a state change belongs —
      // the same append-only log every other module writes to. The
      // dedupe key is the fact itself, so this can never be recorded
      // twice no matter how often a sweep runs.
      await emitTripEvent(candidate.trip_id, candidate.user_id, {
        eventType: "WATCH_PAUSED",
        entityType: "trip",
        entityId: candidate.trip_id,
        metadata: { reason: `Trip status is ${candidate.status}.` },
        dedupeKey: `watch_paused:${candidate.trip_id}:${candidate.status}`,
      });
      await recordWatchRun(claimed.id, { runAt: now, error: null });
      passes.push({
        tripId: candidate.trip_id,
        tripTitle: candidate.title,
        outcome: "finished",
        error: null,
        monitor: null,
      });
      continue;
    }

    try {
      const monitor = await monitorTrip(candidate.trip_id, candidate.user_id, {
        minimumAlertSeverity: claimed.alertMinSeverity,
      });
      await recordWatchRun(claimed.id, { runAt: now, error: null });
      // Phase 24: the pass genuinely ran with nobody pressing anything,
      // so it is recorded as SYSTEM — attributing it to the trip's owner
      // would be the kind of attribution lie an audit log exists to
      // prevent. Awaited so the sweep's report cannot outpace its own
      // audit row; passes that were claimed-but-skipped write nothing.
      await recordSystemAction({
        action: "watch.sweep",
        entityType: "trip",
        entityId: candidate.trip_id,
        metadata: {
          outcome: "ran",
          ownerId: candidate.user_id,
          alertsRaised: monitor.alert !== null,
        },
        requestId: options.auditRequestId ?? null,
      });
      passes.push({
        tripId: candidate.trip_id,
        tripTitle: candidate.title,
        outcome: "ran",
        error: null,
        monitor,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown monitor failure";
      await recordWatchRun(claimed.id, { runAt: now, error: message });
      await recordSystemAction({
        action: "watch.sweep",
        entityType: "trip",
        entityId: candidate.trip_id,
        metadata: { outcome: "failed", ownerId: candidate.user_id, error: message },
        requestId: options.auditRequestId ?? null,
      });
      passes.push({
        tripId: candidate.trip_id,
        tripTitle: candidate.title,
        outcome: "failed",
        error: message,
        monitor: null,
      });
    }
  }

  const stillDue = await countDueWatches({ ownerId: options.ownerId, now });

  return {
    // Informational only — `passes` above is the record of what actually
    // happened. Reported from the same clock the run used.
    now: (now ?? (await databaseNow())).toISOString(),
    passes,
    alertsRaised: passes.filter((pass) => pass.monitor?.alert).length,
    failed: passes.filter((pass) => pass.outcome === "failed").length,
    finished: passes.filter((pass) => pass.outcome === "finished").length,
    stillDue,
  };
}
