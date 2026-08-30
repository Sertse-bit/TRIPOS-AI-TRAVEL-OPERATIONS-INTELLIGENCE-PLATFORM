import { pool } from "@/infrastructure/db";

export interface TravelerRecord {
  id: string;
  tripId: string;
  fullName: string;
  dateOfBirth: Date | null;
  passportNumber: string | null;
  createdAt: Date;
}

function mapRow(row: {
  id: string;
  trip_id: string;
  full_name: string;
  date_of_birth: Date | null;
  passport_number: string | null;
  created_at: Date;
}): TravelerRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    fullName: row.full_name,
    dateOfBirth: row.date_of_birth,
    passportNumber: row.passport_number,
    createdAt: row.created_at,
  };
}

export async function addTraveler(input: {
  tripId: string;
  fullName: string;
  dateOfBirth?: Date | null;
  passportNumber?: string | null;
}): Promise<TravelerRecord> {
  const result = await pool.query(
    `INSERT INTO travelers (trip_id, full_name, date_of_birth, passport_number)
     VALUES ($1, $2, $3, $4)
     RETURNING id, trip_id, full_name, date_of_birth, passport_number, created_at`,
    [input.tripId, input.fullName, input.dateOfBirth ?? null, input.passportNumber ?? null],
  );
  return mapRow(result.rows[0]);
}

export async function findTravelersByTripId(tripId: string): Promise<TravelerRecord[]> {
  const result = await pool.query(
    `SELECT id, trip_id, full_name, date_of_birth, passport_number, created_at
     FROM travelers WHERE trip_id = $1 ORDER BY created_at ASC`,
    [tripId],
  );
  return result.rows.map(mapRow);
}
