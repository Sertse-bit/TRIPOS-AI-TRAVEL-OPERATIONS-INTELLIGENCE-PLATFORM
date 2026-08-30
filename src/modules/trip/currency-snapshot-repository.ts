import { pool } from "@/infrastructure/db";

export interface CurrencySnapshotRecord {
  id: string;
  tripId: string;
  baseCurrency: string;
  targetCurrency: string;
  rate: number;
  provider: string;
  fetchedAt: Date;
}

function mapRow(row: {
  id: string;
  trip_id: string;
  base_currency: string;
  target_currency: string;
  rate: string;
  provider: string;
  fetched_at: Date;
}): CurrencySnapshotRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    baseCurrency: row.base_currency,
    targetCurrency: row.target_currency,
    rate: Number(row.rate),
    provider: row.provider,
    fetchedAt: row.fetched_at,
  };
}

export async function recordCurrencySnapshot(input: {
  tripId: string;
  baseCurrency: string;
  targetCurrency: string;
  rate: number;
  provider: string;
  fetchedAt: Date;
}): Promise<CurrencySnapshotRecord> {
  const result = await pool.query(
    `INSERT INTO currency_snapshots (trip_id, base_currency, target_currency, rate, provider, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, trip_id, base_currency, target_currency, rate, provider, fetched_at`,
    [
      input.tripId,
      input.baseCurrency,
      input.targetCurrency,
      input.rate,
      input.provider,
      input.fetchedAt,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findLatestCurrencySnapshot(
  tripId: string,
  baseCurrency: string,
  targetCurrency: string,
): Promise<CurrencySnapshotRecord | null> {
  const result = await pool.query(
    `SELECT id, trip_id, base_currency, target_currency, rate, provider, fetched_at
     FROM currency_snapshots
     WHERE trip_id = $1 AND base_currency = $2 AND target_currency = $3
     ORDER BY fetched_at DESC LIMIT 1`,
    [tripId, baseCurrency, targetCurrency],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}
