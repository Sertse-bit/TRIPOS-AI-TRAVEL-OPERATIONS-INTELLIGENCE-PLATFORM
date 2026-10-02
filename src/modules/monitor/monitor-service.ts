import { processFlightStatusUpdate } from "@/ai/agents/flight-agent";
import { processWeatherUpdate } from "@/ai/agents/weather-agent";
import { assessTripRisk, listTripRiskAssessments } from "@/modules/risk/risk-service";
import type { RiskSeverity } from "@/modules/risk/risk-repository";
import {
  getTripDigitalTwin,
  getTripFlightStatuses,
  listUserTrips,
} from "@/modules/trip/trip-service";
import { createDeduplicatedNotification } from "@/modules/notification/notification-service";

/**
 * Trip Monitor — Phase 18, the event-driven half of the system.
 *
 * This is the chain Section 9 of docs/ARCHITECTURE.md specifies, minus
 * the parts that would require a queue runtime:
 *
 *   check flight/weather -> did anything actually change?
 *     -> no:  stop. No event, no alert. (The common case.)
 *     -> yes: recompute risk -> did the risk meaning change?
 *              -> no:  stop.
 *              -> yes: one alert, deduplicated.
 *
 * Two deliberate omissions, both recorded rather than faked:
 *
 *  - There is no BullMQ worker here. Phase 1 chose BullMQ (Redis-backed)
 *    and Redis *is* configured, but a durable queue needs a long-running
 *    worker process, which a Next.js request handler cannot honestly be.
 *    Running this synchronously per request keeps every guarantee below
 *    real and testable; swapping in a worker later is a dispatch change,
 *    not a logic change, because this function takes an owner id rather
 *    than a session and does no authorization of its own.
 *  - The AI explanation step (Phase 17) is deliberately NOT invoked. It
 *    needs an Anthropic key, and a monitoring pass must not fail — or
 *    silently skip — because an optional dependency is missing. The
 *    deterministic risk change is what gets alerted on.
 *
 * Anti-spam is the point of most of this file: see
 * `createDeduplicatedNotification`'s doc comment.
 */

/** A risk change worth telling someone about. */
export interface RiskChange {
  previousSeverity: RiskSeverity;
  severity: RiskSeverity;
  previousScore: number;
  riskScore: number;
  /** False when only the score moved within the same severity band. */
  severityChanged: boolean;
}

export interface MonitoredFlightResult {
  flightId: string;
  flightNumber: string;
  status: string | null;
  previousStatus: string | null;
  changed: boolean;
  /** True when the provider call failed and was skipped, not "unchanged". */
  skipped: boolean;
  error?: string;
}

export interface MonitoredDestinationResult {
  destinationId: string;
  city: string;
  changed: boolean;
  skipped: boolean;
  error?: string;
}

/**
 * Why a real, meaningful change produced no notification.
 *
 * `already-reported` is Phase 18's dedupe gate. `below-threshold` is
 * Phase 19's preference: the traveler asked not to be interrupted below
 * a severity, and that instruction is being honoured — which is a
 * different thing from the monitor being silent, and is reported as
 * such so the UI can't present "you asked not to be told" as "nothing
 * happened".
 */
export type AlertSuppressionReason = "already-reported" | "below-threshold";

export interface MonitorRunResult {
  tripId: string;
  checkedFlights: MonitoredFlightResult[];
  checkedDestinations: MonitoredDestinationResult[];
  flightsChanged: number;
  riskChange: RiskChange | null;
  alert: { id: string; title: string } | null;
  /** True when a real change happened but no notification was written. */
  alertSuppressed: boolean;
  /** Why it was suppressed; null when nothing was suppressed. */
  alertSuppressionReason: AlertSuppressionReason | null;
}

export interface MonitorOptions {
  /**
   * Don't notify below this severity — Trip Watch's stored preference,
   * passed in by the sweep. Omitted means no floor at all, which is
   * exactly Phase 18's behaviour, so existing callers are unaffected.
   *
   * This is a floor on *notification*, never on surveillance: the pass
   * still checks everything and still records the risk assessment. It
   * only decides whether to interrupt someone.
   */
  minimumAlertSeverity?: RiskSeverity;
}

/**
 * Whether a risk movement is worth interrupting someone for.
 *
 * Severity band, not raw score: a score drifting 62 -> 64 inside HIGH
 * is not new information, and alerting on it is precisely the spam the
 * brief warns about. Crossing a band is, as is a large move inside one
 * (>= 20 points) — that is a real change of circumstances even if the
 * label didn't move.
 */
export function isMeaningfulRiskChange(change: {
  previousSeverity: RiskSeverity;
  severity: RiskSeverity;
  previousScore: number;
  riskScore: number;
}): { severityChanged: boolean; meaningful: boolean } {
  const order: RiskSeverity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
  const previousRank = order.indexOf(change.previousSeverity);
  const currentRank = order.indexOf(change.severity);

  const severityChanged = currentRank !== previousRank;
  const significantShift = Math.abs(change.riskScore - change.previousScore) >= 20;

  return { severityChanged, meaningful: severityChanged || significantShift };
}

/**
 * Runs one monitoring pass over a single trip the given user owns.
 *
 * Every provider failure is captured rather than thrown: one unreachable
 * flight must not abort the pass for the others. A check that failed is
 * reported as `skipped`, never as "unchanged" — conflating those two
 * would mark a broken check as a healthy one, which is the most
 * dangerous possible lie for a monitor to tell.
 */
export async function monitorTrip(
  tripId: string,
  ownerId: string,
  options: MonitorOptions = {},
): Promise<MonitorRunResult> {
  const [flightsBefore, twin] = await Promise.all([
    getTripFlightStatuses(tripId, ownerId),
    getTripDigitalTwin(tripId, ownerId),
  ]);

  // Read before this pass writes its own assessment, so "changed" is
  // measured against what a traveler would have seen last time.
  const riskHistory = await listTripRiskAssessments(tripId, ownerId);
  const previousRisk = riskHistory[0] ?? null;

  // --- 1. Check every flight and destination. ------------------------------
  const checkedFlights: MonitoredFlightResult[] = [];
  for (const flight of flightsBefore) {
    try {
      const result = await processFlightStatusUpdate(flight.flightId);
      checkedFlights.push({
        flightId: flight.flightId,
        flightNumber: flight.flightNumber,
        status: result.currentStatus,
        previousStatus: result.previousStatus,
        changed: result.changed,
        skipped: false,
      });
    } catch (error) {
      checkedFlights.push({
        flightId: flight.flightId,
        flightNumber: flight.flightNumber,
        status: flight.status,
        previousStatus: flight.status,
        changed: false,
        skipped: true,
        error: error instanceof Error ? error.message : "Unknown provider error",
      });
    }
  }

  const checkedDestinations: MonitoredDestinationResult[] = [];
  for (const destination of twin.destinations) {
    try {
      const result = await processWeatherUpdate(destination.id);
      checkedDestinations.push({
        destinationId: destination.id,
        city: destination.city,
        // The weather agent's own word for "worth telling someone",
        // derived from the real before/after readings.
        changed: result.significant,
        skipped: false,
      });
    } catch (error) {
      checkedDestinations.push({
        destinationId: destination.id,
        city: destination.city,
        changed: false,
        skipped: true,
        error: error instanceof Error ? error.message : "Unknown provider error",
      });
    }
  }

  // --- 2. Recompute risk unconditionally. ----------------------------------
  // Deliberately NOT conditional on "something changed": an approaching
  // departure or a weather shift moves the score with no flight status
  // change at all, and gating on status changes would make the monitor
  // blind to exactly the factors that move on their own.
  const assessed = await assessTripRisk(tripId, ownerId);

  // --- 3. Compare against the previously stored assessment. -----------------
  // On a trip's very first pass there is no prior assessment, so there
  // is nothing to have *changed from*. That pass establishes a baseline
  // and deliberately raises no alert: the score is fully visible in the
  // UI, and alerting every newly-monitored trip would turn "start
  // watching this" into a notification storm. Alerts are for movement a
  // traveler could otherwise miss.
  const current = {
    previousSeverity: previousRisk?.severity ?? assessed.assessment.severity,
    previousScore: previousRisk?.riskScore ?? assessed.assessment.riskScore,
    severity: assessed.assessment.severity,
    riskScore: assessed.assessment.riskScore,
  };
  const { severityChanged, meaningful } = isMeaningfulRiskChange(current);
  const riskChange: RiskChange = { ...current, severityChanged };

  if (!meaningful) {
    return {
      tripId,
      checkedFlights,
      checkedDestinations,
      flightsChanged: checkedFlights.filter((flight) => flight.changed).length,
      riskChange,
      alert: null,
      alertSuppressed: false,
      alertSuppressionReason: null,
    };
  }

  // --- 4. One deduplicated alert. -------------------------------------------
  // Only an escalation is worth interrupting someone about. An improvement
  // is genuinely worth recording as an event and a stored assessment, but
  // pushing a notification at a traveler because their trip got *better*
  // is noise, not service.
  const escalated =
    severityChanged &&
    order(assessed.assessment.severity) >
      order(previousRisk?.severity ?? assessed.assessment.severity);

  // Phase 19: the traveler's own floor on being interrupted. Checked
  // *after* the change test, so "below threshold" can never be reported
  // for a change that did not happen.
  if (
    options.minimumAlertSeverity !== undefined &&
    order(assessed.assessment.severity) < order(options.minimumAlertSeverity)
  ) {
    return {
      tripId,
      checkedFlights,
      checkedDestinations,
      flightsChanged: checkedFlights.filter((flight) => flight.changed).length,
      riskChange,
      alert: null,
      alertSuppressed: true,
      alertSuppressionReason: "below-threshold",
    };
  }

  const outcome = await createDeduplicatedNotification({
    userId: ownerId,
    tripId,
    entityType: "trip",
    entityId: tripId,
    title: escalated
      ? `Risk rose to ${assessed.assessment.severity}`
      : `Risk changed to ${assessed.assessment.severity}`,
    body: `${current.previousScore}/100 (${current.previousSeverity}) → ${assessed.assessment.riskScore}/100 (${assessed.assessment.severity}). Computed from this trip's real flight, weather, schedule, and document data.`,
    dedupeKey: [
      "risk_alert",
      tripId,
      assessed.assessment.severity,
      escalated ? "escalated" : "changed",
    ].join(":"),
  });

  return {
    tripId,
    checkedFlights,
    checkedDestinations,
    flightsChanged: checkedFlights.filter((flight) => flight.changed).length,
    riskChange,
    alert: outcome.notification
      ? { id: outcome.notification.id, title: outcome.notification.title }
      : null,
    alertSuppressed: outcome.suppressed,
    alertSuppressionReason: outcome.suppressed ? "already-reported" : null,
  };
}

function order(severity: RiskSeverity): number {
  return ["LOW", "MEDIUM", "HIGH", "CRITICAL"].indexOf(severity);
}

/**
 * Monitor pass across every trip a user owns. The shape Phase 19's
 * scheduling will call, exposed now so the per-trip work is already
 * correct and tested independently of when scheduling lands.
 */
export async function monitorAllTripsForUser(userId: string): Promise<MonitorRunResult[]> {
  const trips = await listUserTrips(userId);
  const results: MonitorRunResult[] = [];
  for (const trip of trips) {
    results.push(await monitorTrip(trip.id, userId));
  }
  return results;
}
