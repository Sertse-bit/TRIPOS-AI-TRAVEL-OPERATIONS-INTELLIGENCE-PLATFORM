import { randomUUID } from "node:crypto";
import { pool } from "@/infrastructure/db";

export interface TripEventRecord {
  id: string;
  tripId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

function mapRow(row: {
  id: string;
  trip_id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}): TripEventRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

/**
 * Writes one immutable row to trip_events. Rows are never updated or
 * deleted — this is an append-only audit log, per the brief's explicit
 * ask for "immutable event/audit history."
 *
 * dedupeKey: for direct, user-initiated domain operations (create trip,
 * add a destination, etc.), each call is a deliberate, distinct action
 * with no natural retry-duplication risk the way a scheduled snapshot
 * check has (see docs/ARCHITECTURE.md Section 9's idempotency design,
 * which is about *that* case specifically). So when the caller doesn't
 * supply one, a fresh UUID is used — there's nothing to deduplicate
 * against, just a uniqueness requirement to satisfy.
 */
export async function recordTripEvent(input: {
  tripId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
  dedupeKey?: string;
}): Promise<TripEventRecord> {
  const dedupeKey =
    input.dedupeKey ?? `${input.eventType.toLowerCase()}:${input.entityId}:${randomUUID()}`;

  const result = await pool.query(
    `INSERT INTO trip_events (trip_id, event_type, entity_type, entity_id, metadata, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, trip_id, event_type, entity_type, entity_id, metadata, created_at`,
    [
      input.tripId,
      input.eventType,
      input.entityType,
      input.entityId,
      input.metadata ? JSON.stringify(input.metadata) : null,
      dedupeKey,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findEventsByTripId(tripId: string): Promise<TripEventRecord[]> {
  const result = await pool.query(
    `SELECT id, trip_id, event_type, entity_type, entity_id, metadata, created_at
     FROM trip_events WHERE trip_id = $1 ORDER BY created_at DESC`,
    [tripId],
  );
  return result.rows.map(mapRow);
}
