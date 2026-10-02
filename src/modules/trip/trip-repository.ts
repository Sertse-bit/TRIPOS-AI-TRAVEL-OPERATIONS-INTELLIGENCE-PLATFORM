import { pool } from "@/infrastructure/db";

export type TripStatus = "PLANNING" | "UPCOMING" | "ACTIVE" | "COMPLETED" | "CANCELLED";

export interface TripRecord {
  id: string;
  userId: string;
  title: string;
  status: TripStatus;
  startDate: Date | null;
  endDate: Date | null;
  /** Phase 20: the optional budget cap the itinerary is validated against. Always set or cleared together. */
  budgetAmount: number | null;
  budgetCurrency: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** numeric comes back from node-postgres as a string; normalize it once, here. */
function toNumberOrNull(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function mapRow(row: {
  id: string;
  user_id: string;
  title: string;
  status: TripStatus;
  start_date: Date | null;
  end_date: Date | null;
  budget_amount: string | number | null;
  budget_currency: string | null;
  created_at: Date;
  updated_at: Date;
}): TripRecord {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    status: row.status,
    startDate: row.start_date,
    endDate: row.end_date,
    budgetAmount: toNumberOrNull(row.budget_amount),
    budgetCurrency: row.budget_currency,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createTrip(input: {
  userId: string;
  title: string;
  startDate?: Date | null;
  endDate?: Date | null;
}): Promise<TripRecord> {
  const result = await pool.query(
    `INSERT INTO trips (user_id, title, start_date, end_date)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, title, status, start_date, end_date, budget_amount, budget_currency, created_at, updated_at`,
    [input.userId, input.title, input.startDate ?? null, input.endDate ?? null],
  );
  return mapRow(result.rows[0]);
}

export async function findTripById(id: string): Promise<TripRecord | null> {
  const result = await pool.query(
    `SELECT id, user_id, title, status, start_date, end_date, budget_amount, budget_currency, created_at, updated_at
     FROM trips WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findTripsByUserId(userId: string): Promise<TripRecord[]> {
  const result = await pool.query(
    `SELECT id, user_id, title, status, start_date, end_date, budget_amount, budget_currency, created_at, updated_at
     FROM trips WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows.map(mapRow);
}

export async function updateTrip(
  id: string,
  updates: { title?: string; startDate?: Date | null; endDate?: Date | null },
): Promise<TripRecord | null> {
  const result = await pool.query(
    `UPDATE trips SET
       title = COALESCE($2, title),
       start_date = COALESCE($3, start_date),
       end_date = COALESCE($4, end_date),
       updated_at = now()
     WHERE id = $1
     RETURNING id, user_id, title, status, start_date, end_date, budget_amount, budget_currency, created_at, updated_at`,
    [id, updates.title ?? null, updates.startDate ?? null, updates.endDate ?? null],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * Sets or clears the trip's budget cap (Phase 20). Kept separate from the
 * generic updateTrip above because it is the one field pair that must
 * move atomically: `null` clears both columns together, and a value sets
 * both, matching the trips_budget_pair_check constraint.
 */
export async function updateTripBudget(
  id: string,
  budget: { amount: number; currency: string } | null,
): Promise<TripRecord | null> {
  const result = await pool.query(
    `UPDATE trips SET
       budget_amount = $2,
       budget_currency = $3,
       updated_at = now()
     WHERE id = $1
     RETURNING id, user_id, title, status, start_date, end_date, budget_amount, budget_currency, created_at, updated_at`,
    [id, budget?.amount ?? null, budget?.currency ?? null],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * A dedicated function, not folded into the generic updateTrip, because
 * state transitions are a distinct domain concern (per the brief's
 * "changing trip state" as its own listed domain service) — a future
 * phase may want to validate transitions (e.g. can't go from CANCELLED
 * back to ACTIVE) without that validation living inside a generic field
 * updater.
 */
export async function updateTripStatus(id: string, status: TripStatus): Promise<TripRecord | null> {
  const result = await pool.query(
    `UPDATE trips SET status = $2::"TripStatus", updated_at = now()
     WHERE id = $1
     RETURNING id, user_id, title, status, start_date, end_date, budget_amount, budget_currency, created_at, updated_at`,
    [id, status],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}
