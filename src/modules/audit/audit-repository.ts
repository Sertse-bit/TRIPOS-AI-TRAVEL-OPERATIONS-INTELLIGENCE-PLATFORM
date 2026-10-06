import { pool } from "@/infrastructure/db";

/**
 * The only code in the codebase that writes or reads `audit_logs`. The
 * table existed since the Phase 3 schema (with its ActorType enum and
 * requestId correlation column) but had no writer or reader until Phase
 * 24 — this repository is both, following the same raw-pg conventions
 * as api-health-repository.ts.
 *
 * The table has deliberately NO foreign keys (agent and system actors
 * are not rows in `users`), so rows are never cascade-deleted. That is
 * correct for an audit log — history outlives the entity — and it means
 * callers cannot rely on a join to `trips` for ownership; the queries
 * below therefore scope by actor, or by the trip ids captured first
 * through the trip module's own ownership checks.
 */

export type AuditActorType = "USER" | "SYSTEM" | "AI_AGENT";

export interface AuditLogRecord {
  id: string;
  actorType: AuditActorType;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown> | null;
  requestId: string | null;
  createdAt: Date;
}

export interface RecordAuditLogInput {
  actorType: AuditActorType;
  /** User id, agent name (e.g. "flight_agent"), or null for system. */
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown> | null;
  requestId?: string | null;
}

interface AuditRow {
  id: string;
  actor_type: AuditActorType;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  metadata: Record<string, unknown> | null;
  request_id: string | null;
  created_at: Date;
}

function toRecord(row: AuditRow): AuditLogRecord {
  return {
    id: row.id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    metadata: row.metadata,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

const RECORD_FIELDS = `id, actor_type, actor_id, action, entity_type, entity_id, metadata, request_id, created_at`;

/**
 * Appends one audit entry. Failures are NOT swallowed here: the service
 * layer decides whether an audit failure may break the caller's flow
 * (never for background sweeps, and the decision lives there, with its
 * reasoning, not buried in a silent catch).
 */
export async function insertAuditLog(input: RecordAuditLogInput): Promise<AuditLogRecord> {
  const result = await pool.query<AuditRow>(
    `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, metadata, request_id)
     VALUES ($1::"ActorType", $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING ${RECORD_FIELDS}`,
    [
      input.actorType,
      input.actorId ?? null,
      input.action,
      input.entityType,
      input.entityId,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.requestId ?? null,
    ],
  );
  return toRecord(result.rows[0]);
}

export interface ListAuditLogsOptions {
  /** Hard cap, further enforced by the COUNT query below. */
  limit: number;
  offset: number;
  /** Filter to one actor type, when the viewer wants only user actions. */
  actorType?: AuditActorType;
}

export interface AuditLogPage {
  entries: AuditLogRecord[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * A WHERE fragment and the positional params it consumes. Built by the
 * three scope functions below so the placeholders stay numbered
 * correctly no matter which optional filters a caller passes — the
 * count query and the page query then share one clause, which is what
 * keeps `total` honest about the same rows the page is showing.
 */
interface Clause {
  sql: string;
  params: unknown[];
}

/**
 * Runs the COUNT and the page query over one scope. `total` counts every
 * matching row (not just the page) so the UI can say "showing N of M"
 * without guessing, and paging reuses the same parameters.
 */
async function queryAuditPage(
  clause: Clause,
  options: { limit: number; offset: number },
): Promise<AuditLogPage> {
  const count = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM audit_logs WHERE ${clause.sql}`,
    clause.params,
  );

  const limitParam = `$${clause.params.length + 1}`;
  const offsetParam = `$${clause.params.length + 2}`;
  const result = await pool.query<AuditRow>(
    `SELECT ${RECORD_FIELDS}
       FROM audit_logs
      WHERE ${clause.sql}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
    [...clause.params, options.limit, options.offset],
  );

  return {
    entries: result.rows.map(toRecord),
    total: count.rows[0].count,
    limit: options.limit,
    offset: options.offset,
  };
}

function withActorFilter(clause: Clause, actorType: AuditActorType | undefined): Clause {
  if (!actorType) return clause;
  return {
    sql: `${clause.sql} AND actor_type = $${clause.params.length + 1}::"ActorType"`,
    params: [...clause.params, actorType],
  };
}

/**
 * Trip scope: entries that name the trip in metadata, plus entries whose
 * entity IS the trip. Those two shapes cover everything this codebase
 * writes. The caller passes trip ids it has already verified the current
 * user owns — ownership is never re-derived from the audit rows, because
 * the rows carry no owner (no foreign keys, see the note above).
 */
function tripScopeClause(tripIds: string[]): Clause {
  return {
    sql: `(metadata->>'tripId' = ANY($1::text[]) OR (entity_type = 'trip' AND entity_id = ANY($1::text[])))`,
    params: [tripIds],
  };
}

/**
 * Audit history for a specific set of trips, as shown on one trip's
 * page. Strictly trip-scoped: an action that touched nothing on this
 * trip (a login, a notification being marked read) is not in this list,
 * and deliberately so — this is the trip's history, not the person's.
 */
export async function listAuditLogsForTrips(
  tripIds: string[],
  options: ListAuditLogsOptions,
): Promise<AuditLogPage> {
  if (tripIds.length === 0) {
    return { entries: [], total: 0, limit: options.limit, offset: options.offset };
  }
  const clause = withActorFilter(tripScopeClause(tripIds), options.actorType);
  return queryAuditPage(clause, options);
}

/**
 * The signed-in user's whole audit stream. Wider than a single trip's
 * trail on purpose, and still strictly their own:
 *
 *   - USER rows they performed themselves (actor_id = them), which is
 *     the only way account-level actions like auth.login or a
 *     notification being marked read appear at all — those touch no
 *     trip
 *   - every row naming one of their trips (metadata->>'tripId'), which
 *     covers agent deliveries and SYSTEM sweeps
 *   - rows naming them as the subject user (metadata->>'userId')
 *
 * `tripIds` comes from the caller's own trips — see audit-service, which
 * passes `listUserTrips`. Nothing here reads another user's rows.
 */
export async function listAuditLogsForUser(
  userId: string,
  tripIds: string[],
  options: { limit: number; offset: number },
): Promise<AuditLogPage> {
  const clause: Clause = {
    sql: `((actor_type = 'USER' AND actor_id = $1)
           OR metadata->>'tripId' = ANY($2::text[])
           OR metadata->>'userId' = $1
           OR (entity_type = 'trip' AND entity_id = ANY($2::text[])))`,
    params: [userId, tripIds],
  };
  return queryAuditPage(clause, options);
}
