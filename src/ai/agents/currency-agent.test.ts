import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/infrastructure/db";
import { redis } from "@/infrastructure/redis";
import { createTrip } from "@/modules/trip/trip-service";
import {
  convertCurrencyAmount,
  getExchangeRateSnapshot,
  runCurrencyAgentForUser,
} from "@/ai/agents/currency-agent";
import { NotFoundError } from "@/shared/errors";

const OWNER_EMAIL = "currency-agent-owner@example.com";
const OTHER_EMAIL = "currency-agent-other@example.com";
let ownerId: string;
let otherId: string;

async function createTestUser(email: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'Test') RETURNING id`,
    [email],
  );
  return result.rows[0].id;
}

beforeEach(async () => {
  ownerId = await createTestUser(OWNER_EMAIL);
  otherId = await createTestUser(OTHER_EMAIL);
  // Same lesson as Phases 10/11: the resilience cache keys by currency
  // pair, not by test case -- clear it up front for every pair this
  // file uses.
  await redis.del("resilience:currency:ETB:AED");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await pool.query(`DELETE FROM users WHERE email IN ($1, $2)`, [OWNER_EMAIL, OTHER_EMAIL]);
});

function stubRate(rate: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        timestamp: Math.floor(new Date("2026-09-10T14:00:00Z").getTime() / 1000),
        base: "ETB",
        rates: { AED: rate },
      }),
    }),
  );
}

describe("convertCurrencyAmount", () => {
  it("multiplies and rounds to 2 decimal places", () => {
    expect(convertCurrencyAmount(100, 0.0218)).toBe(2.18);
  });

  it("rounds correctly rather than truncating", () => {
    expect(convertCurrencyAmount(100, 0.021849)).toBe(2.18);
    expect(convertCurrencyAmount(100, 0.021851)).toBe(2.19);
  });

  it("handles a zero amount", () => {
    expect(convertCurrencyAmount(0, 0.0218)).toBe(0);
  });
});

describe("getExchangeRateSnapshot: real pipeline against real Postgres", () => {
  it("fetches the rate, records a timestamped snapshot, and emits an event -- with no amount, no conversion is included", async () => {
    const trip = await createTrip(ownerId, { title: "Currency snapshot trip" });
    stubRate(0.0218);

    const result = await getExchangeRateSnapshot(trip.id, "ETB", "AED");

    expect(result.rate).toBe(0.0218);
    expect(result.convertedAmount).toBeNull();

    const snapshotRow = await pool.query(`SELECT * FROM currency_snapshots WHERE id = $1`, [
      result.snapshotId,
    ]);
    expect(snapshotRow.rows).toHaveLength(1);
    expect(Number(snapshotRow.rows[0].rate)).toBe(0.0218);

    const events = await pool.query(
      `SELECT * FROM trip_events WHERE entity_id = $1 AND event_type = 'CURRENCY_SNAPSHOT_RECORDED'`,
      [result.snapshotId],
    );
    expect(events.rows).toHaveLength(1);
  });

  it("includes a real, deterministic conversion when an amount is given", async () => {
    const trip = await createTrip(ownerId, { title: "Currency conversion trip" });
    stubRate(0.0218);

    const result = await getExchangeRateSnapshot(trip.id, "ETB", "AED", 500);

    expect(result.convertedAmount).toBe(convertCurrencyAmount(500, 0.0218));
    expect(result.convertedAmount).toBe(10.9);
  });

  it("every snapshot is recorded, without a significance gate -- unlike the Flight/Weather agents", async () => {
    const trip = await createTrip(ownerId, { title: "Every snapshot trip" });

    stubRate(0.0218);
    await getExchangeRateSnapshot(trip.id, "ETB", "AED");

    await redis.del("resilience:currency:ETB:AED");
    stubRate(0.0218); // identical rate, deliberately -- still expect a second recorded snapshot
    await getExchangeRateSnapshot(trip.id, "ETB", "AED");

    const snapshots = await pool.query(
      `SELECT count(*) FROM currency_snapshots WHERE trip_id = $1`,
      [trip.id],
    );
    expect(Number(snapshots.rows[0].count)).toBe(2);

    const events = await pool.query(
      `SELECT count(*) FROM trip_events WHERE trip_id = $1 AND event_type = 'CURRENCY_SNAPSHOT_RECORDED'`,
      [trip.id],
    );
    expect(Number(events.rows[0].count)).toBe(2); // both recorded, no dedup gate for this agent
  });
});

describe("runCurrencyAgentForUser: authorization", () => {
  it("rejects a caller who doesn't own the trip", async () => {
    const trip = await createTrip(ownerId, { title: "Private currency trip" });
    stubRate(0.0218);

    await expect(runCurrencyAgentForUser(trip.id, otherId, "ETB", "AED")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("succeeds for the real owner and produces the same result shape as the pure function", async () => {
    const trip = await createTrip(ownerId, { title: "Owner currency trip" });
    stubRate(0.0218);

    const result = await runCurrencyAgentForUser(trip.id, ownerId, "ETB", "AED", 100);
    expect(result.convertedAmount).toBe(2.18);
    expect(result.tripId).toBe(trip.id);
  });
});
