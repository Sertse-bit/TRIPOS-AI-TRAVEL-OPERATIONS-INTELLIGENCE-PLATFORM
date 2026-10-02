-- Phase 19 (Trip Watch) — the one schema addition this phase needed.
--
-- WHY THIS FILE EXISTS: `prisma migrate`/`generate` can't run in the
-- build sandbox (see docs/DATABASE.md — the schema-engine binary comes
-- from a domain outside the sandbox's network allowlist), so, exactly as
-- in Phase 3, the DDL below was applied by hand to the real local
-- Postgres instances (tripos_dev and tripos_test) and verified with the
-- phase's tests. `prisma/schema.prisma`'s TripWatch model is the
-- source of truth; this file is what was actually executed.
--
-- In an environment with normal network access, `prisma migrate dev`
-- generates the equivalent migration from schema.prisma instead.

CREATE TABLE IF NOT EXISTS trip_watches (
  -- text ids, not uuid: Prisma maps `String @id @default(uuid())` to text
  -- unless a column is annotated @db.Uuid, and the live tables follow
  -- that (confirmed against information_schema before writing this).
  id                text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  trip_id           text NOT NULL UNIQUE REFERENCES trips (id) ON DELETE CASCADE,
  enabled           boolean NOT NULL DEFAULT true,
  interval_minutes  integer NOT NULL DEFAULT 60,
  alert_min_severity "RiskSeverity" NOT NULL DEFAULT 'MEDIUM',
  last_run_at       timestamptz,
  last_error        text,
  next_run_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Deliberately a database-level bound, unlike the numeric ranges left
  -- to the application in Phase 3. A cadence of 0 or negative would
  -- schedule a paid provider poll in a tight loop; that is worth a
  -- constraint no code path can bypass.
  CONSTRAINT trip_watches_interval_bounds CHECK (interval_minutes BETWEEN 5 AND 1440)
);

-- The sweep's access path: "which enabled watches are due?".
CREATE INDEX IF NOT EXISTS trip_watches_due_idx ON trip_watches (enabled, next_run_at);
