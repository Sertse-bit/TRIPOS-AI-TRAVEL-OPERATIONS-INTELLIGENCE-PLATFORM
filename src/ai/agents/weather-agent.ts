import { getWeatherProvider } from "@/integrations/weather/provider";
import type { NormalizedWeather } from "@/integrations/weather/provider";
import {
  findLatestWeatherSnapshot,
  recordWeatherSnapshot,
  type WeatherSnapshotRecord,
} from "@/modules/trip/weather-snapshot-repository";
import { findDestinationById } from "@/modules/trip/destination-repository";
import { recordTripEvent } from "@/modules/trip/trip-event-repository";
import { getTrip } from "@/modules/trip/trip-service";
import { NotFoundError } from "@/shared/errors";

/**
 * Deterministic, same architectural family as the Flight Agent (Phase
 * 10) and for the identical reason: retrieve/normalize/compare/emit is
 * data processing, not reasoning. The brief states the "no AI here"
 * principle even more explicitly for this phase than Phase 10 did: "Do
 * not allow the LLM to invent numerical weather values." There is no
 * LLM anywhere in this file to even be tempted to do that.
 */

const TEMPERATURE_DELTA_THRESHOLD_C = 8;
const WIND_SPEED_DELTA_THRESHOLD_KPH = 20;

/**
 * Not exhaustive -- Weatherstack's `weather_descriptions` field returns
 * free-text human-readable strings, and there is no complete enumerable
 * list of every possible one. This is a deliberately conservative,
 * documented starting set rather than a claim of completeness; expand it
 * if a real severe condition is observed slipping through unflagged.
 */
const SEVERE_CONDITION_KEYWORDS = [
  "thunderstorm",
  "tornado",
  "hurricane",
  "cyclone",
  "blizzard",
  "snow",
  "hail",
  "storm",
  "freezing",
];

function isSevereCondition(condition: string): boolean {
  const lower = condition.toLowerCase();
  return SEVERE_CONDITION_KEYWORDS.some((keyword) => lower.includes(keyword));
}

export interface WeatherChangeDetection {
  significant: boolean;
  reasons: string[];
}

/**
 * Deliberately DIFFERENT policy from the Flight Agent's "any first
 * reading counts as changed": a baseline reading of "22C and sunny" is
 * not itself news the way a flight's first confirmed status is. Here, a
 * first-ever reading is only "significant" if the conditions are
 * independently severe -- an unremarkable baseline produces no event,
 * a severe one does, and either way a genuine delta from a real
 * previous reading is checked the same way regardless of whether this
 * is the first comparison or the fiftieth.
 */
export function detectSignificantWeatherChange(
  previous: WeatherSnapshotRecord | null,
  current: NormalizedWeather,
): WeatherChangeDetection {
  const reasons: string[] = [];

  if (isSevereCondition(current.condition)) {
    reasons.push(`Current condition is severe: ${current.condition}.`);
  }

  if (previous) {
    const tempDelta = Math.abs(current.temperatureCelsius - previous.temperatureCelsius);
    if (tempDelta >= TEMPERATURE_DELTA_THRESHOLD_C) {
      reasons.push(
        `Temperature changed by ${tempDelta.toFixed(1)}°C (${previous.temperatureCelsius}°C → ${current.temperatureCelsius}°C).`,
      );
    }

    const windDelta = Math.abs(current.windSpeedKph - (previous.windSpeedKph ?? 0));
    if (windDelta >= WIND_SPEED_DELTA_THRESHOLD_KPH) {
      reasons.push(`Wind speed changed by ${windDelta.toFixed(0)} kph.`);
    }

    const previousHadPrecipitation = (previous.precipitationMm ?? 0) > 0;
    const currentHasPrecipitation = current.precipitationMm > 0;
    if (previousHadPrecipitation !== currentHasPrecipitation) {
      reasons.push(
        currentHasPrecipitation ? "Precipitation has started." : "Precipitation has stopped.",
      );
    }
  }

  return { significant: reasons.length > 0, reasons };
}

export interface WeatherAgentResult {
  destinationId: string;
  previousSnapshot: { temperatureCelsius: number; condition: string } | null;
  currentSnapshot: {
    temperatureCelsius: number;
    condition: string;
    windSpeedKph: number;
    precipitationMm: number;
  };
  significant: boolean;
  reasons: string[];
  snapshotId: string;
  eventId: string | null;
}

/**
 * Pure domain operation, no userId -- Phase 19's Trip Watch will call
 * this directly while iterating every monitored destination across
 * every trip. Every numerical value in the result traces directly back
 * to the provider response; nothing here is generated or estimated.
 */
export async function processWeatherUpdate(destinationId: string): Promise<WeatherAgentResult> {
  const destination = await findDestinationById(destinationId);
  if (!destination) {
    throw new NotFoundError("Destination", destinationId);
  }

  const previous = await findLatestWeatherSnapshot(destinationId);
  const current = await getWeatherProvider().getCurrentWeather(
    `${destination.city}, ${destination.country}`,
  );

  const detection = detectSignificantWeatherChange(previous, current);

  const snapshot = await recordWeatherSnapshot({
    destinationId,
    temperatureCelsius: current.temperatureCelsius,
    condition: current.condition,
    windSpeedKph: current.windSpeedKph,
    precipitationMm: current.precipitationMm,
    fetchedAt: new Date(),
  });

  let eventId: string | null = null;
  if (detection.significant) {
    const event = await recordTripEvent({
      tripId: destination.tripId,
      eventType: "WEATHER_CHANGED",
      entityType: "weather_snapshot",
      entityId: snapshot.id,
      metadata: { destinationId, reasons: detection.reasons, condition: current.condition },
      dedupeKey: `weather_changed:${destinationId}:${snapshot.id}`,
    });
    eventId = event.id;
  }

  return {
    destinationId,
    previousSnapshot: previous
      ? { temperatureCelsius: previous.temperatureCelsius, condition: previous.condition }
      : null,
    currentSnapshot: {
      temperatureCelsius: current.temperatureCelsius,
      condition: current.condition,
      windSpeedKph: current.windSpeedKph,
      precipitationMm: current.precipitationMm,
    },
    significant: detection.significant,
    reasons: detection.reasons,
    snapshotId: snapshot.id,
    eventId,
  };
}

/** User-facing entry point: verifies trip ownership (Phase 7) before running the core operation above. */
export async function runWeatherAgentForUser(
  tripId: string,
  destinationId: string,
  userId: string,
): Promise<WeatherAgentResult> {
  await getTrip(tripId, userId);

  const destination = await findDestinationById(destinationId);
  if (!destination || destination.tripId !== tripId) {
    throw new NotFoundError("Destination", destinationId);
  }

  return processWeatherUpdate(destinationId);
}
