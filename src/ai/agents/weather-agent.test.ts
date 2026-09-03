import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/infrastructure/db";
import { redis } from "@/infrastructure/redis";
import { createTrip, addDestinationToTrip } from "@/modules/trip/trip-service";
import {
  detectSignificantWeatherChange,
  processWeatherUpdate,
  runWeatherAgentForUser,
} from "@/ai/agents/weather-agent";
import { NotFoundError, ProviderError } from "@/shared/errors";
import type { WeatherSnapshotRecord } from "@/modules/trip/weather-snapshot-repository";
import type { NormalizedWeather } from "@/integrations/weather/provider";

const OWNER_EMAIL = "weather-agent-owner@example.com";
const OTHER_EMAIL = "weather-agent-other@example.com";
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
  // Same lesson as Phase 10's Flight Agent tests: the resilience cache
  // (Phase 6) keys by the query string, not by test case. Every test in
  // this file uses "Dubai, UAE" -- clear it up front so no test is
  // silently served a previous one's cached response.
  await redis.del("resilience:weather:Dubai, UAE");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await pool.query(`DELETE FROM users WHERE email IN ($1, $2)`, [OWNER_EMAIL, OTHER_EMAIL]);
});

function normalizedWeather(overrides: Partial<NormalizedWeather> = {}): NormalizedWeather {
  return {
    locationName: "Dubai",
    country: "United Arab Emirates",
    observationTime: "10:00 AM",
    temperatureCelsius: 22,
    windSpeedKph: 10,
    precipitationMm: 0,
    humidity: 40,
    condition: "Sunny",
    ...overrides,
  };
}

function snapshotRecord(overrides: Partial<WeatherSnapshotRecord> = {}): WeatherSnapshotRecord {
  return {
    id: "snap-1",
    destinationId: "dest-1",
    temperatureCelsius: 22,
    condition: "Sunny",
    windSpeedKph: 10,
    precipitationMm: 0,
    fetchedAt: new Date(),
    ...overrides,
  };
}

describe("detectSignificantWeatherChange", () => {
  it("is NOT significant for an unremarkable first-ever reading (deliberately different from the Flight Agent's policy)", () => {
    const result = detectSignificantWeatherChange(null, normalizedWeather());
    expect(result.significant).toBe(false);
  });

  it("IS significant for a severe first-ever reading, even with no previous snapshot to compare against", () => {
    const result = detectSignificantWeatherChange(
      null,
      normalizedWeather({ condition: "Thunderstorm" }),
    );
    expect(result.significant).toBe(true);
    expect(result.reasons[0]).toContain("severe");
  });

  it("flags a temperature swing at or above the threshold", () => {
    const previous = snapshotRecord({ temperatureCelsius: 20 });
    const current = normalizedWeather({ temperatureCelsius: 29 }); // delta = 9
    expect(detectSignificantWeatherChange(previous, current).significant).toBe(true);
  });

  it("does not flag a temperature swing under the threshold", () => {
    const previous = snapshotRecord({ temperatureCelsius: 20 });
    const current = normalizedWeather({ temperatureCelsius: 24 }); // delta = 4
    expect(detectSignificantWeatherChange(previous, current).significant).toBe(false);
  });

  it("flags a wind speed swing at or above the threshold", () => {
    const previous = snapshotRecord({ windSpeedKph: 10 });
    const current = normalizedWeather({ windSpeedKph: 35 }); // delta = 25
    expect(detectSignificantWeatherChange(previous, current).significant).toBe(true);
  });

  it("flags precipitation starting", () => {
    const previous = snapshotRecord({ precipitationMm: 0 });
    const current = normalizedWeather({ precipitationMm: 5 });
    expect(detectSignificantWeatherChange(previous, current).significant).toBe(true);
  });

  it("flags precipitation stopping", () => {
    const previous = snapshotRecord({ precipitationMm: 5 });
    const current = normalizedWeather({ precipitationMm: 0 });
    expect(detectSignificantWeatherChange(previous, current).significant).toBe(true);
  });

  it("is not significant when nothing meaningfully changed", () => {
    const previous = snapshotRecord({
      temperatureCelsius: 22,
      windSpeedKph: 10,
      precipitationMm: 0,
    });
    const current = normalizedWeather({
      temperatureCelsius: 23,
      windSpeedKph: 12,
      precipitationMm: 0,
    });
    expect(detectSignificantWeatherChange(previous, current).significant).toBe(false);
  });
});

describe("processWeatherUpdate: real pipeline against real Postgres", () => {
  it("records a baseline snapshot with NO event for an unremarkable first reading", async () => {
    const trip = await createTrip(ownerId, { title: "Baseline weather trip" });
    const destination = await addDestinationToTrip(trip.id, ownerId, {
      city: "Dubai",
      country: "UAE",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          location: { name: "Dubai", country: "United Arab Emirates" },
          current: {
            observation_time: "10:00 AM",
            temperature: 22,
            wind_speed: 10,
            precip: 0,
            humidity: 40,
            weather_descriptions: ["Sunny"],
          },
        }),
      }),
    );

    const result = await processWeatherUpdate(destination.id);

    expect(result.previousSnapshot).toBeNull();
    expect(result.significant).toBe(false);
    expect(result.eventId).toBeNull();
  });

  it("emits an event for a severe first reading", async () => {
    const trip = await createTrip(ownerId, { title: "Severe weather trip" });
    const destination = await addDestinationToTrip(trip.id, ownerId, {
      city: "Dubai",
      country: "UAE",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          location: { name: "Dubai", country: "United Arab Emirates" },
          current: {
            observation_time: "10:00 AM",
            temperature: 18,
            wind_speed: 40,
            precip: 12,
            humidity: 90,
            weather_descriptions: ["Thunderstorm"],
          },
        }),
      }),
    );

    const result = await processWeatherUpdate(destination.id);

    expect(result.significant).toBe(true);
    expect(result.eventId).not.toBeNull();

    const event = await pool.query(`SELECT * FROM trip_events WHERE id = $1`, [result.eventId]);
    expect(event.rows[0].dedupe_key).toBe(`weather_changed:${destination.id}:${result.snapshotId}`);
  });

  it("does not duplicate an event when a follow-up check finds no significant change", async () => {
    const trip = await createTrip(ownerId, { title: "Stable weather trip" });
    const destination = await addDestinationToTrip(trip.id, ownerId, {
      city: "Dubai",
      country: "UAE",
    });

    const stableResponse = {
      ok: true,
      json: async () => ({
        location: { name: "Dubai", country: "United Arab Emirates" },
        current: {
          observation_time: "10:00 AM",
          temperature: 22,
          wind_speed: 10,
          precip: 0,
          humidity: 40,
          weather_descriptions: ["Sunny"],
        },
      }),
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stableResponse));
    await processWeatherUpdate(destination.id); // baseline, unremarkable, no event

    await redis.del("resilience:weather:Dubai, UAE");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          location: { name: "Dubai", country: "United Arab Emirates" },
          current: {
            observation_time: "10:05 AM",
            temperature: 23, // trivial 1-degree change
            wind_speed: 11,
            precip: 0,
            humidity: 41,
            weather_descriptions: ["Sunny"],
          },
        }),
      }),
    );
    const secondResult = await processWeatherUpdate(destination.id);

    expect(secondResult.significant).toBe(false);
    expect(secondResult.eventId).toBeNull();

    const events = await pool.query(
      `SELECT count(*) FROM trip_events WHERE entity_type = 'weather_snapshot' AND metadata->>'destinationId' = $1`,
      [destination.id],
    );
    expect(Number(events.rows[0].count)).toBe(0); // neither check was significant
  });

  it("propagates a genuine provider failure rather than fabricating weather data", async () => {
    const trip = await createTrip(ownerId, { title: "Provider failure trip" });
    const destination = await addDestinationToTrip(trip.id, ownerId, {
      city: "Dubai",
      country: "UAE",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );

    await expect(processWeatherUpdate(destination.id)).rejects.toBeInstanceOf(ProviderError);

    // Confirms nothing was silently recorded in place of the failure.
    const snapshots = await pool.query(
      `SELECT count(*) FROM weather_snapshots WHERE destination_id = $1`,
      [destination.id],
    );
    expect(Number(snapshots.rows[0].count)).toBe(0);
  });
});

describe("runWeatherAgentForUser: authorization", () => {
  it("rejects a caller who doesn't own the trip the destination belongs to", async () => {
    const trip = await createTrip(ownerId, { title: "Private destination trip" });
    const destination = await addDestinationToTrip(trip.id, ownerId, {
      city: "Dubai",
      country: "UAE",
    });

    await expect(runWeatherAgentForUser(trip.id, destination.id, otherId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
