import { NotFoundError } from "@/shared/errors";
import {
  type TripRecord,
  type TripStatus,
  createTrip as createTripRow,
  findTripById,
  findTripsByUserId,
  updateTrip as updateTripRow,
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
  findLatestSnapshotForFlight,
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
import { recordWeatherSnapshot as recordWeatherSnapshotRow } from "@/modules/trip/weather-snapshot-repository";
import { recordCurrencySnapshot as recordCurrencySnapshotRow } from "@/modules/trip/currency-snapshot-repository";

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

  for (const flight of flights) {
    const snapshot = await findLatestSnapshotForFlight(flight.id);
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
