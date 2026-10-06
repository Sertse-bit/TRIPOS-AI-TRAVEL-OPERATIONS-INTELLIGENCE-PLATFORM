import type { AuditAction } from "@/modules/audit/audit-service";
import { recordUserAction, recordAgentDelivery } from "@/modules/audit/audit-service";

/**
 * The route-level audit wiring (Phase 24), one function per audited
 * endpoint so a route's entire audit story is a single call with the
 * entities it already has in hand. Metadata here is deliberately
 * shallow and identifying — titles, codes, counts, not payloads (the
 * full request/response is in the log line under the same requestId,
 * and duplicated payloads would just give stored secrets a second
 * resting place). Every helper takes the DATE objects the route already
 * holds and stringifies only what it summarizes.
 */

/**
 * Summarizes a trip for metadata without embedding the whole row. The
 * title key is `tripTitle` (not `title`) so a reader never has to guess
 * whether a `title` came from the trip or from the entity being audited
 * — a document upload and a trip update both carry one, and they are
 * different titles.
 */
function tripMeta(trip: { id: string; title: string; status: string }): Record<string, unknown> {
  return { tripId: trip.id, tripTitle: trip.title, status: trip.status };
}

function iso(value: Date | undefined | null): string | null {
  return value ? value.toISOString() : null;
}

export function auditTripCreated(input: {
  requestId: string;
  userId: string;
  trip: { id: string; title: string; status: string; startDate: Date | null; endDate: Date | null };
}): void {
  recordUserAction({
    requestId: input.requestId,
    userId: input.userId,
    action: "trip.create",
    entityType: "trip",
    entityId: input.trip.id,
    metadata: {
      ...tripMeta(input.trip),
      startDate: iso(input.trip.startDate),
      endDate: iso(input.trip.endDate),
    },
  });
}

export function auditTripUpdated(input: {
  requestId: string;
  userId: string;
  trip: { id: string; title: string; status: string };
  changedFields: string[];
}): void {
  recordUserAction({
    requestId: input.requestId,
    userId: input.userId,
    action: "trip.update",
    entityType: "trip",
    entityId: input.trip.id,
    metadata: { ...tripMeta(input.trip), changedFields: input.changedFields },
  });
}

export function auditTripStatusChanged(input: {
  requestId: string;
  userId: string;
  trip: { id: string; title: string; status: string };
  previousStatus: string;
}): void {
  recordUserAction({
    requestId: input.requestId,
    userId: input.userId,
    action: "trip.status_change",
    entityType: "trip",
    entityId: input.trip.id,
    metadata: { ...tripMeta(input.trip), previousStatus: input.previousStatus },
  });
}

export function auditDestinationAdded(input: {
  requestId: string;
  userId: string;
  trip: { id: string; title: string; status: string };
  destination: { id: string; city: string; country: string };
}): void {
  recordUserAction({
    requestId: input.requestId,
    userId: input.userId,
    action: "destination.add",
    entityType: "destination",
    entityId: input.destination.id,
    metadata: {
      ...tripMeta(input.trip),
      city: input.destination.city,
      country: input.destination.country,
    },
  });
}

export function auditFlightAdded(input: {
  requestId: string;
  userId: string;
  trip: { id: string; title: string; status: string };
  flight: { id: string; flightNumber: string; departureAirport: string; arrivalAirport: string };
}): void {
  recordUserAction({
    requestId: input.requestId,
    userId: input.userId,
    action: "flight.add",
    entityType: "flight",
    entityId: input.flight.id,
    metadata: {
      ...tripMeta(input.trip),
      flightNumber: input.flight.flightNumber,
      departureAirport: input.flight.departureAirport,
      arrivalAirport: input.flight.arrivalAirport,
    },
  });
}

export function auditTravelerAdded(input: {
  requestId: string;
  userId: string;
  trip: { id: string; title: string; status: string };
  travelerId: string;
}): void {
  recordUserAction({
    requestId: input.requestId,
    userId: input.userId,
    action: "traveler.add",
    entityType: "traveler",
    entityId: input.travelerId,
    metadata: tripMeta(input.trip),
  });
}

export function auditBudgetChanged(input: {
  requestId: string;
  userId: string;
  trip: { id: string; title: string; status: string };
  /** Null means the budget was cleared. */
  currency: string | null;
}): void {
  recordUserAction({
    requestId: input.requestId,
    userId: input.userId,
    action: input.currency === null ? "budget.clear" : "budget.set",
    entityType: "trip",
    entityId: input.trip.id,
    metadata: { ...tripMeta(input.trip), currency: input.currency },
  });
}

export function auditItineraryItemAdded(input: {
  requestId: string;
  userId: string;
  trip: { id: string; title: string; status: string };
  itemId: string;
  itemType: string;
  source: string;
}): void {
  recordUserAction({
    requestId: input.requestId,
    userId: input.userId,
    action: "itinerary.item_add",
    entityType: "itinerary_item",
    entityId: input.itemId,
    metadata: { ...tripMeta(input.trip), itemType: input.itemType, source: input.source },
  });
}

export function auditItineraryItemUpdated(input: {
  requestId: string;
  userId: string;
  trip: { id: string; title: string; status: string };
  itemId: string;
}): void {
  recordUserAction({
    requestId: input.requestId,
    userId: input.userId,
    action: "itinerary.item_update",
    entityType: "itinerary_item",
    entityId: input.itemId,
    metadata: tripMeta(input.trip),
  });
}

export function auditItineraryItemDeleted(input: {
  requestId: string;
  userId: string;
  trip: { id: string; title: string; status: string };
  itemId: string;
}): void {
  recordUserAction({
    requestId: input.requestId,
    userId: input.userId,
    action: "itinerary.item_delete",
    entityType: "itinerary_item",
    entityId: input.itemId,
    metadata: tripMeta(input.trip),
  });
}

export function auditDocumentUploaded(input: {
  requestId: string;
  userId: string;
  trip: { id: string; title: string; status: string };
  documentId: string;
  status: string;
}): void {
  recordUserAction({
    requestId: input.requestId,
    userId: input.userId,
    action: "document.upload",
    entityType: "trip_document",
    entityId: input.documentId,
    metadata: { ...tripMeta(input.trip), status: input.status },
  });
}

export function auditDocumentReindexed(input: {
  requestId: string;
  userId: string;
  trip: { id: string; title: string; status: string };
  documentId: string;
  chunks: number;
  embeddingProvider: string;
  semantic: boolean;
}): void {
  recordUserAction({
    requestId: input.requestId,
    userId: input.userId,
    action: "document.reindex",
    entityType: "trip_document",
    entityId: input.documentId,
    metadata: {
      ...tripMeta(input.trip),
      chunks: input.chunks,
      embeddingProvider: input.embeddingProvider,
      semantic: input.semantic,
    },
  });
}

export function auditNotificationRead(input: {
  requestId: string;
  userId: string;
  notificationId: string;
  updated: boolean;
}): void {
  recordUserAction({
    requestId: input.requestId,
    userId: input.userId,
    action: "notification.read",
    entityType: "notification",
    entityId: input.notificationId,
    metadata: { updated: input.updated },
  });
}

export function auditWatchUpserted(input: {
  requestId: string;
  userId: string;
  trip: { id: string; title: string; status: string };
  watch: { enabled: boolean; intervalMinutes: number; alertMinSeverity: string };
}): void {
  recordUserAction({
    requestId: input.requestId,
    userId: input.userId,
    action: "watch.upsert",
    entityType: "trip_watch",
    entityId: input.trip.id,
    metadata: {
      ...tripMeta(input.trip),
      enabled: input.watch.enabled,
      intervalMinutes: input.watch.intervalMinutes,
      alertMinSeverity: input.watch.alertMinSeverity,
    },
  });
}

/** The agent-delivery side, also one call per route. */
export function auditAgentDelivery(input: {
  requestId: string;
  userId: string;
  agentName: string;
  tripId: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
}): void {
  recordAgentDelivery({
    requestId: input.requestId,
    agentName: input.agentName,
    userId: input.userId,
    tripId: input.tripId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: input.metadata,
  });
}

// Re-export for the auth routes, which audit inline (no trip in hand).
export { recordUserAction, recordAgentDelivery };
export type { AuditAction };
