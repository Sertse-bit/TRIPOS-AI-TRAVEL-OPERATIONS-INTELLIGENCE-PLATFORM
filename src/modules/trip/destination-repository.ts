import { pool } from "@/infrastructure/db";

export interface DestinationRecord {
  id: string;
  tripId: string;
  city: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  arrivalDate: Date | null;
  departureDate: Date | null;
  orderIndex: number;
  createdAt: Date;
}

function mapRow(row: {
  id: string;
  trip_id: string;
  city: string;
  country: string;
  latitude: string | null;
  longitude: string | null;
  arrival_date: Date | null;
  departure_date: Date | null;
  order_index: number;
  created_at: Date;
}): DestinationRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    city: row.city,
    country: row.country,
    // pg returns DECIMAL columns as strings by default to avoid silent
    // precision loss -- explicitly parsed here since lat/lon precision
    // loss at this magnitude is not a real concern for this use case.
    latitude: row.latitude !== null ? Number(row.latitude) : null,
    longitude: row.longitude !== null ? Number(row.longitude) : null,
    arrivalDate: row.arrival_date,
    departureDate: row.departure_date,
    orderIndex: row.order_index,
    createdAt: row.created_at,
  };
}

export async function addDestination(input: {
  tripId: string;
  city: string;
  country: string;
  latitude?: number | null;
  longitude?: number | null;
  arrivalDate?: Date | null;
  departureDate?: Date | null;
  orderIndex?: number;
}): Promise<DestinationRecord> {
  const result = await pool.query(
    `INSERT INTO destinations (trip_id, city, country, latitude, longitude, arrival_date, departure_date, order_index)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, trip_id, city, country, latitude, longitude, arrival_date, departure_date, order_index, created_at`,
    [
      input.tripId,
      input.city,
      input.country,
      input.latitude ?? null,
      input.longitude ?? null,
      input.arrivalDate ?? null,
      input.departureDate ?? null,
      input.orderIndex ?? 0,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findDestinationsByTripId(tripId: string): Promise<DestinationRecord[]> {
  const result = await pool.query(
    `SELECT id, trip_id, city, country, latitude, longitude, arrival_date, departure_date, order_index, created_at
     FROM destinations WHERE trip_id = $1 ORDER BY order_index ASC, created_at ASC`,
    [tripId],
  );
  return result.rows.map(mapRow);
}

export async function findDestinationById(id: string): Promise<DestinationRecord | null> {
  const result = await pool.query(
    `SELECT id, trip_id, city, country, latitude, longitude, arrival_date, departure_date, order_index, created_at
     FROM destinations WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}
