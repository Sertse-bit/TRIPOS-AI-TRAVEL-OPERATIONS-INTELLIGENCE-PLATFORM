import { logger } from "@/infrastructure/logger";
import {
  insertAuditLog,
  listAuditLogsForTrips,
  listAuditLogsForUser,
  type AuditActorType,
  type AuditLogPage,
  type AuditLogRecord,
} from "@/modules/audit/audit-repository";
import { getTrip, listUserTrips } from "@/modules/trip/trip-service";

/**
 * Audit trail — Phase 24. Every write in this module records something
 * that genuinely happened: a state change a user made, a persisted AI
 * delivery, or a scheduler action. Nothing here is speculative and
 * nothing synthesizes an entry for a read.
 *
 * Actor types map to the schema's `ActorType` enum:
 *   USER     — an authenticated traveler acting on their own data
 *   AI_AGENT — a named agent persisting something to the trip
 *   SYSTEM   — infrastructure acting with no user behind it
 *
 * The requestId ties each row back to the API envelope and the
 * structured log line (see shared/api-response.ts and the schema's
 * column comment) — one id, three places.
 */

/** Actions this phase actually writes, with the labels the UI shows. */
export type AuditAction =
  // Trip lifecycle (user)
  | "trip.create"
  | "trip.update"
  | "trip.status_change"
  | "destination.add"
  | "flight.add"
  | "traveler.add"
  | "budget.set"
  | "budget.clear"
  | "itinerary.item_add"
  | "itinerary.item_update"
  | "itinerary.item_delete"
  // Documents (user)
  | "document.upload"
  | "document.reindex"
  // Notifications (user) — account-level, so it shows on the audit
  // stream but not on any single trip's trail.
  | "notification.read"
  // Auth (user) — account-level, same as above.
  | "auth.register"
  | "auth.login"
  | "auth.logout"
  // Trip Watch (user sweep) and the scheduler (system)
  | "watch.upsert"
  | "watch.sweep"
  // Persisted agent deliveries
  | "flight.status_update"
  | "weather.snapshot_recorded"
  | "risk.assessed"
  | "recommendation.created"
  | "itinerary.plan_generated";

/**
 * Records a USER audit entry for an action that already succeeded.
 *
 * Fire-and-forget ON PURPOSE, and the reasoning is in the Phase 22
 * precedent: an audit entry must never be the reason a state change
 * that already committed appears to have failed. Failure is logged at
 * warn (never silent), and the trade-off is stated here rather than
 * hidden: a lost audit row is a smaller failure than a lost mutation,
 * and the requestId still ties the action to its log line even then.
 */
export function recordUserAction(input: {
  requestId: string;
  userId: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}): void {
  void insertAuditLog({
    actorType: "USER",
    actorId: input.userId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: input.metadata ?? null,
    requestId: input.requestId,
  }).catch((error: unknown) => {
    logger.warn(
      { err: error, action: input.action, requestId: input.requestId },
      "Audit write failed",
    );
  });
}

/**
 * Records an AI_AGENT entry for a delivery that was actually persisted.
 * Called with the outcome already known — the agent ran, the row was
 * written — because an agent attempt that changed nothing (an unchanged
 * flight, a non-significant weather reading, a refused LLM call) is
 * recorded by its own domain, not invented here.
 */
export function recordAgentDelivery(input: {
  requestId: string;
  agentName: string;
  userId: string;
  tripId: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
}): void {
  void insertAuditLog({
    actorType: "AI_AGENT",
    actorId: input.agentName,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: { ...input.metadata, tripId: input.tripId, userId: input.userId },
    requestId: input.requestId,
  }).catch((error: unknown) => {
    logger.warn(
      { err: error, action: input.action, requestId: input.requestId },
      "Audit write failed",
    );
  });
}

/**
 * Records a SYSTEM entry for scheduler-driven work. A watch sweep pass
 * is the first honest SYSTEM actor in the codebase: no user pressed
 * anything, and attributing the pass to the trip's owner would be the
 * kind of attribution lie an audit log exists to prevent.
 *
 * Unlike the user and agent flows this is awaited: a sweep runs in the
 * background already (request-triggered today — see watch-service), so
 * waiting costs a caller nothing, and an audit failure must not
 * silently shrink the sweep's own report.
 */
export async function recordSystemAction(input: {
  action: AuditAction;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
}): Promise<void> {
  await insertAuditLog({
    actorType: "SYSTEM",
    actorId: null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: input.metadata ?? null,
    requestId: input.requestId ?? null,
  });
}

/**
 * A trip's audit trail, most recent first. The trip module's own
 * ownership check runs first, so a stranger's trip is indistinguishable
 * from one that doesn't exist — NotFoundError either way, everywhere.
 */
export async function getTripAuditTrail(
  tripId: string,
  userId: string,
  options: { limit?: number; offset?: number; actorType?: AuditActorType } = {},
): Promise<AuditLogPage> {
  // The trip module owns this check, and its answer is the same for a
  // stranger's trip and an unknown one: NotFoundError, everywhere.
  await getTrip(tripId, userId);
  return listAuditLogsForTrips([tripId], {
    limit: normalizeLimit(options.limit),
    offset: normalizeOffset(options.offset),
    actorType: options.actorType,
  });
}

/**
 * The signed-in user's audit stream, ownership-scoped by construction:
 * the trip id set comes from `listUserTrips`, never from the audit rows
 * (which carry no owner — see the repository's note on foreign keys).
 *
 * Wider than a single trip's trail by design: the caller's own USER
 * rows are included even when they name no trip, so account-level
 * actions (sign-in, sign-out, registering) and per-notification reads
 * are visible rather than recorded-and-invisible. That widening is in
 * the repository query, which scopes on the caller's own actor id only.
 */
export async function getUserAuditTrail(
  userId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<AuditLogPage> {
  const trips = await listUserTrips(userId);
  const tripIds = trips.map((trip) => trip.id);
  return listAuditLogsForUser(userId, tripIds, {
    limit: normalizeLimit(options.limit),
    offset: normalizeOffset(options.offset),
  });
}

/** Shared paging bounds — same ceiling for the API and the pages. */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) return 50;
  return Math.min(limit, 100);
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isInteger(offset) || offset < 0) return 0;
  return offset;
}

export type { AuditLogPage, AuditLogRecord, AuditActorType };
