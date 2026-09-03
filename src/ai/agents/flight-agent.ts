import { getAviationProvider } from "@/integrations/aviation/provider";
import type { NormalizedFlightStatus } from "@/integrations/aviation/provider";
import {
  findFlightById,
  findLatestSnapshotForFlight,
  insertFlightStatusSnapshot,
  type FlightStatusValue,
} from "@/modules/trip/flight-repository";
import { recordTripEvent } from "@/modules/trip/trip-event-repository";
import { getTrip } from "@/modules/trip/trip-service";
import { NotFoundError } from "@/shared/errors";

/**
 * This is deliberately a plain deterministic service, not an
 * AgentDefinition run through Phase 9's LLM orchestrator. Every
 * responsibility the brief lists for this agent -- retrieve, normalize,
 * compare, emit -- is a data operation, not a reasoning or generation
 * task. Routing this through an LLM would be exactly what the brief's
 * own Section 37 warns against: "use AI where deterministic logic is
 * better." (Phase 16's Risk Engine is the deliberately hybrid
 * counter-example: deterministic score, AI explanation layered on top --
 * this agent has no such layer because it doesn't need one.)
 */

/**
 * Aviationstack's normalized vocabulary (scheduled/active/landed/
 * cancelled/incident/diverted/unknown -- see integrations/aviation/
 * provider.ts) does not line up one-to-one with this domain's
 * FlightStatus enum (UNKNOWN/SCHEDULED/DELAYED/CANCELLED/LANDED/
 * COMPLETED, fixed at the database level since Phase 3). This mapping is
 * the explicit, documented reconciliation between the two -- not an
 * assumption that they already match, which they don't.
 *
 * - DELAYED is derived from delay minutes, not the provider's raw
 *   status string -- a flight can be "active" (airborne) or "scheduled"
 *   and still be meaningfully delayed. 15 minutes matches the common
 *   on-time-performance threshold industry trackers use, so a landing
 *   two minutes late doesn't get flagged as a disruption.
 * - "incident" and "diverted" both map to CANCELLED: neither has its
 *   own slot in this domain's enum, and both represent the flight not
 *   proceeding as planned, which is the same operational signal a
 *   traveler needs from a disruption standpoint.
 * - COMPLETED is not derived from provider data at all here -- the
 *   provider has no signal for "landed, deplaned, and fully done" beyond
 *   "landed" itself. Left for a later phase (Trip Watch, time-based) to
 *   decide if that distinction ever matters in practice.
 */
const DELAY_THRESHOLD_MINUTES = 15;

export function mapProviderStatusToFlightStatus(
  normalized: NormalizedFlightStatus,
): FlightStatusValue {
  if (normalized.flightStatus === "cancelled" || normalized.flightStatus === "diverted") {
    return "CANCELLED";
  }
  if (normalized.flightStatus === "incident") {
    return "CANCELLED";
  }
  if (normalized.flightStatus === "landed") {
    return "LANDED";
  }

  const worstDelay = Math.max(
    normalized.departure.delayMinutes ?? 0,
    normalized.arrival.delayMinutes ?? 0,
  );
  if (worstDelay > DELAY_THRESHOLD_MINUTES) {
    return "DELAYED";
  }

  if (normalized.flightStatus === "scheduled" || normalized.flightStatus === "active") {
    return "SCHEDULED";
  }

  return "UNKNOWN";
}

export interface FlightAgentResult {
  flightRecordId: string;
  previousStatus: FlightStatusValue | null;
  currentStatus: FlightStatusValue;
  changed: boolean;
  delayMinutes: number | null;
  snapshotId: string;
  eventId: string | null;
}

/**
 * The core domain operation: no userId, no authorization -- this is
 * what Phase 19's Trip Watch will call directly when it iterates over
 * every monitored flight across every trip, not one user's request. A
 * user-facing caller should go through runFlightAgentForUser below
 * instead, which checks trip ownership first.
 *
 * Never invents flight data (brief's explicit rule for this phase): if
 * the provider call fails, this throws rather than fabricating a
 * plausible-looking status.
 */
export async function processFlightStatusUpdate(
  flightRecordId: string,
): Promise<FlightAgentResult> {
  const flight = await findFlightById(flightRecordId);
  if (!flight) {
    throw new NotFoundError("Flight", flightRecordId);
  }

  const previousSnapshot = await findLatestSnapshotForFlight(flightRecordId);
  const normalized = await getAviationProvider().getFlightStatus(flight.flightNumber);

  if (!normalized) {
    // The provider had nothing for this flight number right now --
    // genuinely different from a provider *failure* (which throws, per
    // the resilience layer). Record UNKNOWN rather than silently
    // skipping, so "we checked and got nothing" is itself visible in
    // the append-only history, not indistinguishable from "never checked."
    const snapshot = await insertFlightStatusSnapshot({
      flightRecordId,
      status: "UNKNOWN",
      fetchedAt: new Date(),
    });
    return {
      flightRecordId,
      previousStatus: (previousSnapshot?.status as FlightStatusValue) ?? null,
      currentStatus: "UNKNOWN",
      changed: previousSnapshot?.status !== "UNKNOWN",
      delayMinutes: null,
      snapshotId: snapshot.id,
      eventId: null,
    };
  }

  const currentStatus = mapProviderStatusToFlightStatus(normalized);
  const delayMinutes =
    Math.max(normalized.departure.delayMinutes ?? 0, normalized.arrival.delayMinutes ?? 0) || null;

  const snapshot = await insertFlightStatusSnapshot({
    flightRecordId,
    status: currentStatus,
    actualDeparture: normalized.departure.actual ? new Date(normalized.departure.actual) : null,
    actualArrival: normalized.arrival.actual ? new Date(normalized.arrival.actual) : null,
    delayMinutes,
    rawProviderResponse: normalized,
    fetchedAt: new Date(),
  });

  const previousStatus = (previousSnapshot?.status as FlightStatusValue) ?? null;
  const changed = previousStatus !== currentStatus;

  let eventId: string | null = null;
  if (changed) {
    // Only a MEANINGFUL change gets an event -- this is the brief's own
    // distinction ("emit domain events when meaningful changes happen"),
    // not every single check. Dedupe key ties to this exact snapshot
    // (Phase 1/3's idempotency design), so a retry of this same check
    // can never double-emit.
    const event = await recordTripEvent({
      tripId: flight.tripId,
      eventType: "FLIGHT_UPDATED",
      entityType: "flight_record",
      entityId: flightRecordId,
      metadata: { previousStatus, currentStatus, delayMinutes },
      dedupeKey: `flight_updated:${flightRecordId}:${snapshot.id}`,
    });
    eventId = event.id;
  }

  return {
    flightRecordId,
    previousStatus,
    currentStatus,
    changed,
    delayMinutes,
    snapshotId: snapshot.id,
    eventId,
  };
}

/**
 * User-facing entry point: verifies the caller actually owns the trip
 * this flight belongs to (Phase 7's requireOwnedTrip, via getTrip) before
 * running the same core operation above.
 */
export async function runFlightAgentForUser(
  tripId: string,
  flightRecordId: string,
  userId: string,
): Promise<FlightAgentResult> {
  await getTrip(tripId, userId);

  const flight = await findFlightById(flightRecordId);
  if (!flight || flight.tripId !== tripId) {
    throw new NotFoundError("Flight", flightRecordId);
  }

  return processFlightStatusUpdate(flightRecordId);
}
