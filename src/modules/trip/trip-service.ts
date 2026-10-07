import { pool } from "@/infrastructure/db";
import { NotFoundError } from "@/shared/errors";
import {
  type TripRecord,
  type TripStatus,
  createTrip as createTripRow,
  findTripById,
  findTripsByUserId,
  updateTrip as updateTripRow,
  updateTripBudget as updateTripBudgetRow,
  updateTripStatus as updateTripStatusRow,
} from "@/modules/trip/trip-repository";
import {
  type TravelerRecord,
  addTraveler as addTravelerRow,
  findTravelersByTripId,
} from "@/modules/trip/traveler-repository";
import {
  type DestinationRecord,
  addDestination as addDestinationRow,
  findDestinationsByTripId,
} from "@/modules/trip/destination-repository";
import {
  type FlightRecordRow,
  addFlightRecord as addFlightRow,
  findFlightsByTripId,
  findLatestSnapshotsForFlights,
} from "@/modules/trip/flight-repository";
import {
  type TripDocumentRecord,
  attachDocument as attachDocumentRow,
  findDocumentsByTripId,
} from "@/modules/trip/document-repository";
import {
  type TripEventRecord,
  recordTripEvent,
  findEventsByTripId,
} from "@/modules/trip/trip-event-repository";
import {
  type RecommendationRecord,
  createRecommendation as createRecommendationRow,
  findRecommendationsByTripId,
} from "@/modules/trip/recommendation-repository";
import { recordWeatherSnapshot as recordWeatherSnapshotRow } from "@/modules/trip/weather-snapshot-repository";
import { recordCurrencySnapshot as recordCurrencySnapshotRow } from "@/modules/trip/currency-snapshot-repository";

// Re-exported as part of this module's public interface: other modules may
// reference these shapes (e.g. the Phase 20 planner needs TripRecord and
// DestinationRecord) without importing the trip module's internal
// repositories, per the project's module boundary rule.
export type { TripRecord } from "@/modules/trip/trip-repository";
export type { DestinationRecord } from "@/modules/trip/destination-repository";

/**
 * Resolves a trip and verifies ownership in one step. Deliberately
 * returns the SAME NotFoundError whether the trip doesn't exist at all
 * or exists but belongs to a different user — distinguishing the two
 * would let one user probe trip IDs to learn which ones exist, the same
 * enumeration concern already reasoned about for login in Phase 4.
 */
async function requireOwnedTrip(tripId: string, userId: string): Promise<TripRecord> {
  const trip = await findTripById(tripId);
  if (!trip || trip.userId !== userId) {
    throw new NotFoundError("Trip", tripId);
  }
  return trip;
}

// --- Trip CRUD -----------------------------------------------------------

export async function createTrip(
  userId: string,
  input: { title: string; startDate?: Date; endDate?: Date },
): Promise<TripRecord> {
  const trip = await createTripRow({
    userId,
    title: input.title,
    startDate: input.startDate,
    endDate: input.endDate,
  });
  await recordTripEvent({
    tripId: trip.id,
    eventType: "TRIP_CREATED",
    entityType: "trip",
    entityId: trip.id,
    metadata: { title: trip.title },
  });
  return trip;
}

export async function listUserTrips(userId: string): Promise<TripRecord[]> {
  return findTripsByUserId(userId);
}

/** The four counts the analytics page shows, per user. */
export interface UserTripEntityCounts {
  trips: number;
  destinations: number;
  flights: number;
  travelers: number;
}

/**
 * The analytics page's aggregates, in ONE query (Phase 29).
 *
 * It used to call `getTripDigitalTwin` per trip and add up array lengths,
 * which meant roughly a dozen round trips per trip — 480 for a user with
 * 40 trips, measured at 134 ms in scripts/bench-read-paths.ts — for four
 * integers. The counts below are computed by Postgres over the same rows
 * (`trips` filtered by owner, then each child table joined back through
 * its trip), so the answer is identical while the cost is constant in the
 * number of trips.
 *
 * Ownership is the `user_id = $1` predicate on trips, exactly as
 * `listUserTrips` scopes it; no child row is ever counted through a trip
 * this user does not own.
 */
export async function getUserTripEntityCounts(userId: string): Promise<UserTripEntityCounts> {
  const result = await pool.query<{
    trips: number;
    destinations: number;
    flights: number;
    travelers: number;
  }>(
    `SELECT
       (SELECT count(*) FROM trips WHERE user_id = $1)::int AS trips,
       (SELECT count(*) FROM destinations d
          JOIN trips t ON t.id = d.trip_id WHERE t.user_id = $1)::int AS destinations,
       (SELECT count(*) FROM flight_records f
          JOIN trips t ON t.id = f.trip_id WHERE t.user_id = $1)::int AS flights,
       (SELECT count(*) FROM travelers v
          JOIN trips t ON t.id = v.trip_id WHERE t.user_id = $1)::int AS travelers`,
    [userId],
  );
  return result.rows[0];
}

export async function getTrip(tripId: string, userId: string): Promise<TripRecord> {
  return requireOwnedTrip(tripId, userId);
}

export async function updateTripDetails(
  tripId: string,
  userId: string,
  updates: { title?: string; startDate?: Date; endDate?: Date },
): Promise<TripRecord> {
  await requireOwnedTrip(tripId, userId);
  const updated = await updateTripRow(tripId, updates);
  if (!updated) throw new NotFoundError("Trip", tripId);

  await recordTripEvent({
    tripId,
    eventType: "TRIP_UPDATED",
    entityType: "trip",
    entityId: tripId,
    metadata: { ...updates },
  });
  return updated;
}

/**
 * Its own function, not folded into updateTripDetails, because state
 * transitions are a distinct domain concern (brief: "changing trip
 * state" is its own listed service). No transition validation yet
 * (e.g. blocking CANCELLED -> ACTIVE) — noted as a known gap rather
 * than silently assumed correct; add it here if it becomes a real need.
 */
export async function changeTripStatus(
  tripId: string,
  userId: string,
  newStatus: TripStatus,
): Promise<TripRecord> {
  const trip = await requireOwnedTrip(tripId, userId);
  const updated = await updateTripStatusRow(tripId, newStatus);
  if (!updated) throw new NotFoundError("Trip", tripId);

  await recordTripEvent({
    tripId,
    eventType: "TRIP_STATUS_CHANGED",
    entityType: "trip",
    entityId: tripId,
    metadata: { from: trip.status, to: newStatus },
  });
  return updated;
}

// --- Travelers / Destinations / Flights -----------------------------------

export async function addTravelerToTrip(
  tripId: string,
  userId: string,
  input: { fullName: string; dateOfBirth?: Date; passportNumber?: string },
): Promise<TravelerRecord> {
  await requireOwnedTrip(tripId, userId);
  const traveler = await addTravelerRow({ tripId, ...input });
  await recordTripEvent({
    tripId,
    eventType: "TRAVELER_ADDED",
    entityType: "traveler",
    entityId: traveler.id,
    metadata: { fullName: traveler.fullName },
  });
  return traveler;
}

export async function addDestinationToTrip(
  tripId: string,
  userId: string,
  input: {
    city: string;
    country: string;
    latitude?: number;
    longitude?: number;
    arrivalDate?: Date;
    departureDate?: Date;
    orderIndex?: number;
  },
): Promise<DestinationRecord> {
  await requireOwnedTrip(tripId, userId);
  const destination = await addDestinationRow({ tripId, ...input });
  await recordTripEvent({
    tripId,
    eventType: "DESTINATION_ADDED",
    entityType: "destination",
    entityId: destination.id,
    metadata: { city: destination.city, country: destination.country },
  });
  return destination;
}

export async function addFlightToTrip(
  tripId: string,
  userId: string,
  input: {
    flightNumber: string;
    airline: string;
    departureAirport: string;
    arrivalAirport: string;
    scheduledDeparture: Date;
    scheduledArrival: Date;
  },
): Promise<FlightRecordRow> {
  await requireOwnedTrip(tripId, userId);
  const flight = await addFlightRow({ tripId, ...input });
  await recordTripEvent({
    tripId,
    eventType: "FLIGHT_ADDED",
    entityType: "flight_record",
    entityId: flight.id,
    metadata: { flightNumber: flight.flightNumber, airline: flight.airline },
  });
  return flight;
}

export async function attachDocumentToTrip(
  tripId: string,
  userId: string,
  input: { originalFilename: string; storageKey: string; mimeType: string; sizeBytes: number },
): Promise<TripDocumentRecord> {
  await requireOwnedTrip(tripId, userId);
  const document = await attachDocumentRow({ tripId, uploadedBy: userId, ...input });
  await recordTripEvent({
    tripId,
    eventType: "DOCUMENT_UPLOADED",
    entityType: "trip_document",
    entityId: document.id,
    metadata: { originalFilename: document.originalFilename },
  });
  return document;
}

// --- Snapshots -------------------------------------------------------------
//
// Storage side only — the fetch-from-provider logic that produces the
// values passed in here belongs to Phase 11 (Weather Agent) and Phase 12
// (Currency Agent). This is what "recording snapshots" means as a Phase 7
// domain service: persist + emit the event, given already-normalized data.

export async function recordWeatherSnapshot(
  tripId: string,
  userId: string,
  destinationId: string,
  data: {
    temperatureCelsius: number;
    condition: string;
    windSpeedKph?: number;
    precipitationMm?: number;
    fetchedAt: Date;
  },
) {
  await requireOwnedTrip(tripId, userId);
  const snapshot = await recordWeatherSnapshotRow({ destinationId, ...data });
  await recordTripEvent({
    tripId,
    eventType: "WEATHER_CHANGED",
    entityType: "weather_snapshot",
    entityId: snapshot.id,
    metadata: { destinationId, condition: snapshot.condition },
  });
  return snapshot;
}

export async function recordCurrencySnapshot(
  tripId: string,
  userId: string,
  data: {
    baseCurrency: string;
    targetCurrency: string;
    rate: number;
    provider: string;
    fetchedAt: Date;
  },
) {
  await requireOwnedTrip(tripId, userId);
  const snapshot = await recordCurrencySnapshotRow({ tripId, ...data });
  await recordTripEvent({
    tripId,
    eventType: "CURRENCY_SNAPSHOT_RECORDED",
    entityType: "currency_snapshot",
    entityId: snapshot.id,
    metadata: { pair: `${data.baseCurrency}/${data.targetCurrency}`, rate: data.rate },
  });
  return snapshot;
}

// --- Operational state -----------------------------------------------------

export type OperationalStateLabel = "INCOMPLETE" | "ON_TRACK" | "ATTENTION_NEEDED" | "DISRUPTED";

export interface OperationalState {
  tripId: string;
  state: OperationalStateLabel;
  factors: string[];
  calculatedAt: string;
}

const DISRUPTIVE_STATUSES = new Set(["CANCELLED", "DIVERTED"]);

/**
 * Deliberately simple and deterministic: no invented AI risk scoring
 * here (that's explicitly Phase 16's job — a weighted deterministic
 * model with an AI explanation layer on top). This is the basic,
 * genuinely-data-driven precursor: incomplete setup, or the worst known
 * flight status among the trip's flights. Phase 16 extends this with
 * weather/document/schedule factors; it doesn't need to replace this
 * flight-status logic, just add to it.
 */
export async function calculateOperationalState(
  tripId: string,
  userId: string,
): Promise<OperationalState> {
  await requireOwnedTrip(tripId, userId);

  const [destinations, flights] = await Promise.all([
    findDestinationsByTripId(tripId),
    findFlightsByTripId(tripId),
  ]);

  if (destinations.length === 0 && flights.length === 0) {
    return {
      tripId,
      state: "INCOMPLETE",
      factors: ["No destinations or flights have been added to this trip yet."],
      calculatedAt: new Date().toISOString(),
    };
  }

  const factors: string[] = [];
  let worst: OperationalStateLabel = "ON_TRACK";

  // Phase 29: every flight's latest snapshot in one query. The previous
  // version asked per flight, so a trip with twenty flights paid twenty
  // round trips to answer the same question. Factors are still built in
  // flight order below, so the rendered result is unchanged.
  const snapshots = await findLatestSnapshotsForFlights(flights.map((flight) => flight.id));

  for (const flight of flights) {
    const snapshot = snapshots.get(flight.id);
    if (!snapshot) continue;

    if (DISRUPTIVE_STATUSES.has(snapshot.status)) {
      worst = "DISRUPTED";
      factors.push(`Flight ${flight.flightNumber} is ${snapshot.status.toLowerCase()}.`);
    } else if (snapshot.status === "DELAYED" && worst !== "DISRUPTED") {
      worst = "ATTENTION_NEEDED";
      const delay = snapshot.delayMinutes ? ` by ${snapshot.delayMinutes} minutes` : "";
      factors.push(`Flight ${flight.flightNumber} is delayed${delay}.`);
    }
  }

  if (factors.length === 0) {
    factors.push(
      flights.length > 0 ? "All flights are on schedule." : "No flight status data yet.",
    );
  }

  return { tripId, state: worst, factors, calculatedAt: new Date().toISOString() };
}

// --- Digital twin assembly ---------------------------------------------

export interface TripDigitalTwin {
  trip: TripRecord;
  travelers: TravelerRecord[];
  destinations: DestinationRecord[];
  flights: FlightRecordRow[];
  documents: TripDocumentRecord[];
  operationalState: OperationalState;
}

/**
 * The full assembled view the brief's Trip Digital Twin concept
 * describes. Risk assessments and recommendations are genuinely empty
 * until Phase 16/17 exist to write them — not stubbed with fake data,
 * just not part of this type yet, since there's no write path for them
 * to reflect.
 */
export async function getTripDigitalTwin(tripId: string, userId: string): Promise<TripDigitalTwin> {
  const trip = await requireOwnedTrip(tripId, userId);

  const [travelers, destinations, flights, documents, operationalState] = await Promise.all([
    findTravelersByTripId(tripId),
    findDestinationsByTripId(tripId),
    findFlightsByTripId(tripId),
    findDocumentsByTripId(tripId),
    calculateOperationalState(tripId, userId),
  ]);

  return { trip, travelers, destinations, flights, documents, operationalState };
}

export async function getTripEventHistory(
  tripId: string,
  userId: string,
): Promise<TripEventRecord[]> {
  await requireOwnedTrip(tripId, userId);
  return findEventsByTripId(tripId);
}

export async function getTripDocuments(
  tripId: string,
  userId: string,
): Promise<TripDocumentRecord[]> {
  await requireOwnedTrip(tripId, userId);
  return findDocumentsByTripId(tripId);
}

/**
 * Public seam for the Itinerary module (Phase 20): a trip's destinations,
 * ownership-checked. The itinerary planner needs the closed set of cities
 * a generated plan is allowed to schedule against, and item validation
 * needs to confirm a destination id genuinely belongs to this trip.
 */
export async function getTripDestinations(
  tripId: string,
  userId: string,
): Promise<DestinationRecord[]> {
  await requireOwnedTrip(tripId, userId);
  return findDestinationsByTripId(tripId);
}

/**
 * Sets or clears a trip's budget cap (Phase 20). The Itinerary module owns
 * the budget *validation*, but the cap itself is a trip field, so the
 * write stays here behind the same ownership check as every other trip
 * mutation.
 */
export async function updateTripBudget(
  tripId: string,
  userId: string,
  budget: { amount: number; currency: string } | null,
): Promise<TripRecord> {
  await requireOwnedTrip(tripId, userId);
  const updated = await updateTripBudgetRow(tripId, budget);
  if (!updated) throw new NotFoundError("Trip", tripId);
  return updated;
}

// --- Public seams for the Risk Engine (Phase 16) -------------------------
//
// The Risk Engine is a separate module, so per the brief's module
// boundary rule it may only call the Trip Service's public interface --
// never its repositories. These three functions are that interface for
// the read-only data the scoring model needs. Each returns genuinely
// stored rows (or an honest empty list when nothing has been recorded
// yet); none of them substitutes a default value for missing data.

/**
 * One row per flight: its latest status snapshot if one exists, or
 * `status: null` when the Flight Agent has never polled it. Deliberately
 * NOT filtered to flights that have snapshots — "this flight has never
 * been checked" is itself information the risk model reports on, and
 * hiding it would make an unmonitored trip look identical to a
 * fully-monitored on-time one.
 *
 * One statement (DISTINCT ON), not a query per flight.
 */
export async function getTripFlightStatuses(
  tripId: string,
  userId: string,
): Promise<
  Array<{
    flightId: string;
    flightNumber: string;
    airline: string;
    scheduledDeparture: Date;
    scheduledArrival: Date;
    status: string | null;
    delayMinutes: number | null;
    fetchedAt: Date | null;
  }>
> {
  await requireOwnedTrip(tripId, userId);

  const result = await pool.query(
    `SELECT f.id AS flight_id, f.flight_number, f.airline,
            f.scheduled_departure, f.scheduled_arrival,
            s.status, s.delay_minutes, s.fetched_at
     FROM flight_records f
     LEFT JOIN LATERAL (
       SELECT status, delay_minutes, fetched_at
       FROM flight_status_snapshots
       WHERE flight_record_id = f.id
       ORDER BY fetched_at DESC
       LIMIT 1
     ) s ON true
     WHERE f.trip_id = $1
     ORDER BY f.scheduled_departure ASC`,
    [tripId],
  );

  return result.rows.map((row) => ({
    flightId: row.flight_id,
    flightNumber: row.flight_number,
    airline: row.airline,
    scheduledDeparture: row.scheduled_departure,
    scheduledArrival: row.scheduled_arrival,
    status: row.status ?? null,
    delayMinutes: row.delay_minutes ?? null,
    fetchedAt: row.fetched_at ?? null,
  }));
}

/**
 * One row per destination, with its latest weather snapshot if one has
 * ever been fetched (Weather Agent). Same rule as flights above: a
 * destination that was never checked is reported as `snapshot: null`
 * rather than omitted.
 */
export async function getTripWeatherSnapshots(
  tripId: string,
  userId: string,
): Promise<
  Array<{
    destinationId: string;
    city: string;
    country: string;
    snapshot: {
      temperatureCelsius: number;
      condition: string;
      windSpeedKph: number | null;
      precipitationMm: number | null;
      fetchedAt: Date;
    } | null;
  }>
> {
  await requireOwnedTrip(tripId, userId);

  const result = await pool.query(
    `SELECT d.id AS destination_id, d.city, d.country,
            w.temperature_celsius, w.condition, w.wind_speed_kph,
            w.precipitation_mm, w.fetched_at
     FROM destinations d
     LEFT JOIN LATERAL (
       SELECT temperature_celsius, condition, wind_speed_kph,
              precipitation_mm, fetched_at
       FROM weather_snapshots
       WHERE destination_id = d.id
       ORDER BY fetched_at DESC
       LIMIT 1
     ) w ON true
     WHERE d.trip_id = $1
     ORDER BY d.order_index ASC, d.created_at ASC`,
    [tripId],
  );

  return result.rows.map((row) => ({
    destinationId: row.destination_id,
    city: row.city,
    country: row.country,
    snapshot:
      row.fetched_at === null
        ? null
        : {
            temperatureCelsius: Number(row.temperature_celsius),
            condition: row.condition,
            windSpeedKph: row.wind_speed_kph !== null ? Number(row.wind_speed_kph) : null,
            precipitationMm: row.precipitation_mm !== null ? Number(row.precipitation_mm) : null,
            fetchedAt: row.fetched_at,
          },
  }));
}

/**
 * The one supported way for another module to append to a trip's event
 * history. Wraps the internal append-only repository so the boundary is
 * explicit and so ownership can be checked by the same rule as every
 * other trip operation.
 */
export async function emitTripEvent(
  tripId: string,
  userId: string,
  input: {
    eventType: string;
    entityType: string;
    entityId: string;
    metadata?: Record<string, unknown>;
    /**
     * Only meaningful for fact-shaped events ("the trip is finished, so
     * watching stopped") where re-emitting the same statement must be a
     * safe no-op. User-initiated actions leave it unset and get a
     * fresh key, since two genuine clicks are two real events.
     */
    dedupeKey?: string;
  },
): Promise<TripEventRecord> {
  await requireOwnedTrip(tripId, userId);
  return recordTripEvent({ tripId, ...input });
}

/**
 * Writes an explainable recommendation for a trip the caller owns, and
 * records the RECOMMENDATION_CREATED event alongside it.
 *
 * `riskAssessmentId` links the recommendation to the deterministic score
 * it explains (Phase 16/17). It is the caller's — i.e. the risk module's
 * — job to supply the id of an assessment it actually read; this
 * function does not invent one, so a recommendation can never end up
 * pointing at a score that was never computed.
 */
export async function createTripRecommendation(
  tripId: string,
  userId: string,
  input: {
    decision: string;
    evidence: Record<string, unknown>;
    reasoningSummary: string;
    recommendationText: string;
    confidence: number;
    riskAssessmentId?: string | null;
  },
): Promise<RecommendationRecord> {
  await requireOwnedTrip(tripId, userId);
  const recommendation = await createRecommendationRow({ tripId, ...input });
  await recordTripEvent({
    tripId,
    eventType: "RECOMMENDATION_CREATED",
    entityType: "recommendation",
    entityId: recommendation.id,
    metadata: {
      confidence: recommendation.confidence,
      riskAssessmentId: recommendation.riskAssessmentId,
    },
  });
  return recommendation;
}

/** A trip's stored recommendations, newest first. */
export async function getTripRecommendations(
  tripId: string,
  userId: string,
): Promise<RecommendationRecord[]> {
  await requireOwnedTrip(tripId, userId);
  return findRecommendationsByTripId(tripId);
}
