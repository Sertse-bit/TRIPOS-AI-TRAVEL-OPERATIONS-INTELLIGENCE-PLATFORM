import { pool } from "@/infrastructure/db";

export interface FlightRecordRow {
  id: string;
  tripId: string;
  flightNumber: string;
  airline: string;
  departureAirport: string;
  arrivalAirport: string;
  scheduledDeparture: Date;
  scheduledArrival: Date;
  createdAt: Date;
}

function mapRow(row: {
  id: string;
  trip_id: string;
  flight_number: string;
  airline: string;
  departure_airport: string;
  arrival_airport: string;
  scheduled_departure: Date;
  scheduled_arrival: Date;
  created_at: Date;
}): FlightRecordRow {
  return {
    id: row.id,
    tripId: row.trip_id,
    flightNumber: row.flight_number,
    airline: row.airline,
    departureAirport: row.departure_airport,
    arrivalAirport: row.arrival_airport,
    scheduledDeparture: row.scheduled_departure,
    scheduledArrival: row.scheduled_arrival,
    createdAt: row.created_at,
  };
}

export async function addFlightRecord(input: {
  tripId: string;
  flightNumber: string;
  airline: string;
  departureAirport: string;
  arrivalAirport: string;
  scheduledDeparture: Date;
  scheduledArrival: Date;
}): Promise<FlightRecordRow> {
  const result = await pool.query(
    `INSERT INTO flight_records
       (trip_id, flight_number, airline, departure_airport, arrival_airport, scheduled_departure, scheduled_arrival)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, trip_id, flight_number, airline, departure_airport, arrival_airport, scheduled_departure, scheduled_arrival, created_at`,
    [
      input.tripId,
      input.flightNumber,
      input.airline,
      input.departureAirport,
      input.arrivalAirport,
      input.scheduledDeparture,
      input.scheduledArrival,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findFlightsByTripId(tripId: string): Promise<FlightRecordRow[]> {
  const result = await pool.query(
    `SELECT id, trip_id, flight_number, airline, departure_airport, arrival_airport, scheduled_departure, scheduled_arrival, created_at
     FROM flight_records WHERE trip_id = $1 ORDER BY scheduled_departure ASC`,
    [tripId],
  );
  return result.rows.map(mapRow);
}

export async function findFlightById(id: string): Promise<FlightRecordRow | null> {
  const result = await pool.query(
    `SELECT id, trip_id, flight_number, airline, departure_airport, arrival_airport, scheduled_departure, scheduled_arrival, created_at
     FROM flight_records WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * The most recent status snapshot per flight, if any exist yet. Returns
 * null for a flight with no snapshots -- expected and normal until
 * Phase 10's Flight Agent starts actually polling Aviationstack for it.
 */
export async function findLatestSnapshotForFlight(
  flightRecordId: string,
): Promise<{ status: string; delayMinutes: number | null; fetchedAt: Date } | null> {
  const result = await pool.query(
    `SELECT status, delay_minutes, fetched_at
     FROM flight_status_snapshots
     WHERE flight_record_id = $1
     ORDER BY fetched_at DESC
     LIMIT 1`,
    [flightRecordId],
  );
  if (!result.rows[0]) return null;
  return {
    status: result.rows[0].status,
    delayMinutes: result.rows[0].delay_minutes,
    fetchedAt: result.rows[0].fetched_at,
  };
}
