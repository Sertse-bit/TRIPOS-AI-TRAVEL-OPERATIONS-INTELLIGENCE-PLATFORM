import { pool } from "@/infrastructure/db";

/**
 * Itinerary repository — Phase 20. Dumb data access only: no ownership
 * checks, no validation, no events. Those live in the itinerary service,
 * which is the module's public interface (same split as every other
 * repository in this codebase).
 *
 * `itinerary_day` is read back with an explicit ::text cast rather than
 * letting node-postgres parse a `date` into a JS Date. A calendar day is
 * not an instant: parsing it into a Date and formatting it back can land
 * on the previous/next day depending on the server's timezone, which for
 * a day-by-day plan is a real correctness bug, not a cosmetic one. The
 * string 'YYYY-MM-DD' is the honest representation and is what the API
 * and the planner's grounding checks compare.
 */

export const ITINERARY_ITEM_TYPES = [
  "FLIGHT",
  "LODGING",
  "ACTIVITY",
  "TRANSPORT",
  "MEAL",
  "OTHER",
] as const;

export type ItineraryItemType = (typeof ITINERARY_ITEM_TYPES)[number];
export type ItineraryItemSource = "USER" | "AI_PLANNER";

export interface ItineraryItemRecord {
  id: string;
  tripId: string;
  /** Calendar day, 'YYYY-MM-DD'. */
  itineraryDay: string;
  /** 'HH:MM' 24-hour, or null. */
  startTime: string | null;
  endTime: string | null;
  title: string;
  itemType: ItineraryItemType;
  location: string | null;
  destinationId: string | null;
  notes: string | null;
  estimatedCost: number | null;
  currency: string | null;
  source: ItineraryItemSource;
  planRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InsertItineraryItemInput {
  tripId: string;
  itineraryDay: string;
  startTime?: string | null;
  endTime?: string | null;
  title: string;
  itemType: ItineraryItemType;
  location?: string | null;
  destinationId?: string | null;
  notes?: string | null;
  estimatedCost?: number | null;
  currency?: string | null;
  source: ItineraryItemSource;
  planRunId?: string | null;
}

const ITEM_COLUMNS = `id, trip_id, itinerary_day::text AS itinerary_day, start_time, end_time,
  title, item_type, location, destination_id, notes, estimated_cost, currency,
  source, plan_run_id, created_at, updated_at`;

function mapRow(row: {
  id: string;
  trip_id: string;
  itinerary_day: string;
  start_time: string | null;
  end_time: string | null;
  title: string;
  item_type: ItineraryItemType;
  location: string | null;
  destination_id: string | null;
  notes: string | null;
  estimated_cost: string | number | null;
  currency: string | null;
  source: ItineraryItemSource;
  plan_run_id: string | null;
  created_at: Date;
  updated_at: Date;
}): ItineraryItemRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    itineraryDay: row.itinerary_day,
    startTime: row.start_time,
    endTime: row.end_time,
    title: row.title,
    itemType: row.item_type,
    location: row.location,
    destinationId: row.destination_id,
    notes: row.notes,
    // numeric arrives as a string from node-postgres.
    estimatedCost: row.estimated_cost === null ? null : Number(row.estimated_cost),
    currency: row.currency,
    source: row.source,
    planRunId: row.plan_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertItineraryItem(
  input: InsertItineraryItemInput,
): Promise<ItineraryItemRecord> {
  const result = await pool.query(
    `INSERT INTO itinerary_items
       (trip_id, itinerary_day, start_time, end_time, title, item_type,
        location, destination_id, notes, estimated_cost, currency, source, plan_run_id)
     VALUES ($1, $2::date, $3, $4, $5, $6::"ItineraryItemType", $7, $8, $9, $10, $11,
             $12::"ItineraryItemSource", $13)
     RETURNING ${ITEM_COLUMNS}`,
    [
      input.tripId,
      input.itineraryDay,
      input.startTime ?? null,
      input.endTime ?? null,
      input.title,
      input.itemType,
      input.location ?? null,
      input.destinationId ?? null,
      input.notes ?? null,
      input.estimatedCost ?? null,
      input.currency ?? null,
      input.source,
      input.planRunId ?? null,
    ],
  );
  return mapRow(result.rows[0]);
}

/**
 * Replaces a trip's AI-generated plan in one transaction: every previous
 * AI_PLANNER row is deleted and the new run's rows are inserted, or
 * neither happens. A crash halfway through must not be able to leave a
 * half-replaced itinerary behind.
 *
 * USER rows are never touched — regenerating a plan must not silently
 * delete items the traveler typed in themselves.
 *
 * Returns the newly inserted rows plus how many AI rows were replaced,
 * so the caller can report what actually changed rather than asserting
 * it changed.
 */
export async function replaceAiPlanItems(
  tripId: string,
  planRunId: string,
  items: Array<Omit<InsertItineraryItemInput, "tripId" | "source" | "planRunId">>,
): Promise<{ items: ItineraryItemRecord[]; replacedCount: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const deleted = await client.query(
      `DELETE FROM itinerary_items
       WHERE trip_id = $1 AND source = 'AI_PLANNER'::"ItineraryItemSource"`,
      [tripId],
    );

    const inserted: ItineraryItemRecord[] = [];
    for (const item of items) {
      const result = await client.query(
        `INSERT INTO itinerary_items
           (trip_id, itinerary_day, start_time, end_time, title, item_type,
            location, destination_id, notes, source, plan_run_id)
         VALUES ($1, $2::date, $3, $4, $5, $6::"ItineraryItemType", $7, $8, $9,
                 'AI_PLANNER'::"ItineraryItemSource", $10)
         RETURNING ${ITEM_COLUMNS}`,
        [
          tripId,
          item.itineraryDay,
          item.startTime ?? null,
          item.endTime ?? null,
          item.title,
          item.itemType,
          item.location ?? null,
          item.destinationId ?? null,
          item.notes ?? null,
          planRunId,
        ],
      );
      inserted.push(mapRow(result.rows[0]));
    }

    await client.query("COMMIT");
    return { items: inserted, replacedCount: deleted.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function findItineraryItemsByTripId(tripId: string): Promise<ItineraryItemRecord[]> {
  const result = await pool.query(
    `SELECT ${ITEM_COLUMNS}
     FROM itinerary_items
     WHERE trip_id = $1
     ORDER BY itinerary_day ASC, start_time ASC NULLS FIRST, created_at ASC`,
    [tripId],
  );
  return result.rows.map(mapRow);
}

export async function findItineraryItemById(id: string): Promise<ItineraryItemRecord | null> {
  const result = await pool.query(`SELECT ${ITEM_COLUMNS} FROM itinerary_items WHERE id = $1`, [
    id,
  ]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * Field-by-field update where `undefined` means "leave unchanged" and an
 * explicit `null` clears a nullable column. Distinguished on purpose:
 * COALESCE-style updates (used elsewhere in this codebase) cannot clear a
 * value at all, and clearing a wrong cost or a stale time is a normal
 * thing a traveler needs to be able to do.
 */
export interface UpdateItineraryItemInput {
  itineraryDay?: string;
  startTime?: string | null;
  endTime?: string | null;
  title?: string;
  itemType?: ItineraryItemType;
  location?: string | null;
  destinationId?: string | null;
  notes?: string | null;
  estimatedCost?: number | null;
  currency?: string | null;
}

export async function updateItineraryItem(
  id: string,
  updates: UpdateItineraryItemInput,
): Promise<ItineraryItemRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [id];

  function assign(column: string, value: unknown, cast = "") {
    values.push(value);
    sets.push(`${column} = $${values.length}${cast}`);
  }

  if (updates.itineraryDay !== undefined) assign("itinerary_day", updates.itineraryDay, "::date");
  if (updates.startTime !== undefined) assign("start_time", updates.startTime);
  if (updates.endTime !== undefined) assign("end_time", updates.endTime);
  if (updates.title !== undefined) assign("title", updates.title);
  if (updates.itemType !== undefined)
    assign("item_type", updates.itemType, '::"ItineraryItemType"');
  if (updates.location !== undefined) assign("location", updates.location);
  if (updates.destinationId !== undefined) assign("destination_id", updates.destinationId);
  if (updates.notes !== undefined) assign("notes", updates.notes);
  if (updates.estimatedCost !== undefined) assign("estimated_cost", updates.estimatedCost);
  if (updates.currency !== undefined) assign("currency", updates.currency);

  if (sets.length === 0) return findItineraryItemById(id);

  sets.push("updated_at = now()");
  const result = await pool.query(
    `UPDATE itinerary_items SET ${sets.join(", ")} WHERE id = $1 RETURNING ${ITEM_COLUMNS}`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function deleteItineraryItem(id: string): Promise<boolean> {
  const result = await pool.query(`DELETE FROM itinerary_items WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}
