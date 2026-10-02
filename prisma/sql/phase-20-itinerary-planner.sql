-- Phase 20 (AI Itinerary Planner) — the schema this phase needed.
--
-- WHY THIS FILE EXISTS: same sandbox constraint as Phases 3, 19 and the
-- rest: `prisma migrate`/`generate` can't run here (the schema-engine
-- binary is fetched from a domain outside the sandbox's network
-- allowlist). `prisma/schema.prisma`'s ItineraryItem model and the Trip
-- budget columns are the source of truth; this is what was actually
-- executed against tripos_dev and tripos_test, verified by the phase's
-- tests. In a normal environment `prisma migrate dev` generates the
-- equivalent migration from schema.prisma instead.

-- 1. Item type + source enums.
--    item_type is a real enum (small, stable set) rather than a text
--    column: the DB should reject an unknown type outright, and the
--    planner's grounding check validates against the same closed list.
DO $$ BEGIN
  CREATE TYPE "ItineraryItemType" AS ENUM ('FLIGHT', 'LODGING', 'ACTIVITY', 'TRANSPORT', 'MEAL', 'OTHER');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ItineraryItemSource" AS ENUM ('USER', 'AI_PLANNER');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. The itinerary itself.
CREATE TABLE IF NOT EXISTS itinerary_items (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  trip_id         text NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
  itinerary_day   date NOT NULL,
  start_time      text,
  end_time        text,
  title           text NOT NULL,
  item_type       "ItineraryItemType" NOT NULL DEFAULT 'OTHER',
  location        text,
  destination_id  text REFERENCES destinations (id) ON DELETE SET NULL,
  notes           text,
  estimated_cost  numeric(12, 2),
  currency        char(3),
  source          "ItineraryItemSource" NOT NULL DEFAULT 'USER',
  plan_run_id     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- HH:MM 24-hour. A free-text time column with no constraint would let
  -- "25:99" or "afternoon" through from any future code path.
  CONSTRAINT itinerary_items_time_format CHECK (
    (start_time IS NULL OR start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
    AND (end_time IS NULL OR end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
  ),
  -- A cost without a currency is uninterpretable, and a currency without
  -- a cost is noise: the two travel together.
  CONSTRAINT itinerary_items_cost_currency_together CHECK (
    (estimated_cost IS NULL) = (currency IS NULL)
  ),
  CONSTRAINT itinerary_items_cost_non_negative CHECK (estimated_cost IS NULL OR estimated_cost >= 0)
);

CREATE INDEX IF NOT EXISTS itinerary_items_trip_day_idx
  ON itinerary_items (trip_id, itinerary_day, start_time);

-- 3. The optional budget cap the itinerary's costs are validated against.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS budget_amount numeric(12, 2);
ALTER TABLE trips ADD COLUMN IF NOT EXISTS budget_currency char(3);

DO $$ BEGIN
  ALTER TABLE trips ADD CONSTRAINT trips_budget_pair_check CHECK (
    (budget_amount IS NULL) = (budget_currency IS NULL)
    AND (budget_amount IS NULL OR budget_amount > 0)
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
