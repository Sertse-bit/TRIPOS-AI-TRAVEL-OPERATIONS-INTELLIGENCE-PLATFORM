import { pool } from "@/infrastructure/db";

export interface WeatherSnapshotRecord {
  id: string;
  destinationId: string;
  temperatureCelsius: number;
  condition: string;
  windSpeedKph: number | null;
  precipitationMm: number | null;
  fetchedAt: Date;
}

function mapRow(row: {
  id: string;
  destination_id: string;
  temperature_celsius: string;
  condition: string;
  wind_speed_kph: string | null;
  precipitation_mm: string | null;
  fetched_at: Date;
}): WeatherSnapshotRecord {
  return {
    id: row.id,
    destinationId: row.destination_id,
    temperatureCelsius: Number(row.temperature_celsius),
    condition: row.condition,
    windSpeedKph: row.wind_speed_kph !== null ? Number(row.wind_speed_kph) : null,
    precipitationMm: row.precipitation_mm !== null ? Number(row.precipitation_mm) : null,
    fetchedAt: row.fetched_at,
  };
}

export async function recordWeatherSnapshot(input: {
  destinationId: string;
  temperatureCelsius: number;
  condition: string;
  windSpeedKph?: number | null;
  precipitationMm?: number | null;
  fetchedAt: Date;
}): Promise<WeatherSnapshotRecord> {
  const result = await pool.query(
    `INSERT INTO weather_snapshots (destination_id, temperature_celsius, condition, wind_speed_kph, precipitation_mm, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, destination_id, temperature_celsius, condition, wind_speed_kph, precipitation_mm, fetched_at`,
    [
      input.destinationId,
      input.temperatureCelsius,
      input.condition,
      input.windSpeedKph ?? null,
      input.precipitationMm ?? null,
      input.fetchedAt,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findLatestWeatherSnapshot(
  destinationId: string,
): Promise<WeatherSnapshotRecord | null> {
  const result = await pool.query(
    `SELECT id, destination_id, temperature_celsius, condition, wind_speed_kph, precipitation_mm, fetched_at
     FROM weather_snapshots WHERE destination_id = $1 ORDER BY fetched_at DESC LIMIT 1`,
    [destinationId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}
