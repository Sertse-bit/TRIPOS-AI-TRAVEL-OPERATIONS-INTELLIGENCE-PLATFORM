import type { RiskSeverity } from "@/modules/risk/risk-repository";

/**
 * Risk Engine — Phase 16, the deterministic scoring model.
 *
 * This file is pure: no database, no clock, no I/O. Every input is
 * passed in already gathered (risk-service.ts does that), and the same
 * input always produces the same score. That is deliberate and is the
 * whole point — docs/ARCHITECTURE.md Section 14 deferred "risk scoring
 * formula and factor weights" to this phase precisely so the model
 * would be the domain's, never an LLM's. Nothing here calls a model,
 * and no score is ever invented when the underlying data is missing:
 * a factor with no data contributes zero and says so in its evidence.
 */

/**
 * Factor weights, summing to 100. Flight disruption dominates because a
 * cancelled or diverted flight is the one thing that reliably changes
 * the operational picture; weather is real but only counts when the
 * recorded readings actually cross a threshold; schedule proximity
 * scales how much runway there is to react; document/index coverage is
 * a readiness signal, not a disruption.
 *
 * Exported so tests and docs can assert the sum rather than restate it.
 */
export const RISK_FACTOR_WEIGHTS = {
  flightDisruption: 40,
  weatherSeverity: 20,
  scheduleProximity: 15,
  documentReadiness: 10,
  itineraryCompleteness: 15,
} as const;

export const TOTAL_RISK_WEIGHT = Object.values(RISK_FACTOR_WEIGHTS).reduce(
  (total, weight) => total + weight,
  0,
);

/**
 * Score thresholds -> severity. Documented, deterministic boundaries.
 *
 * A weighted score alone would rate a single cancelled flight as merely
 * "HIGH" — 40 points out of 100, because the other four factors are
 * genuinely quiet. That understates it: a cancellation or diversion
 * means the trip cannot proceed as planned, which is categorically
 * different from "several things are slightly elevated". So it is a
 * documented floor, not a fudge factor, and the same distinction
 * `calculateOperationalState()` already draws with its DISRUPTED label
 * in the Trip Service.
 */
export const SEVERITY_THRESHOLDS: ReadonlyArray<{ min: number; severity: RiskSeverity }> = [
  { min: 60, severity: "CRITICAL" },
  { min: 35, severity: "HIGH" },
  { min: 15, severity: "MEDIUM" },
];

const SEVERITY_ORDER: RiskSeverity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export function severityForScore(score: number): RiskSeverity {
  for (const threshold of SEVERITY_THRESHOLDS) {
    if (score >= threshold.min) return threshold.severity;
  }
  return "LOW";
}

/** The higher of two severities, for applying floors. */
function maxSeverity(a: RiskSeverity, b: RiskSeverity): RiskSeverity {
  return SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b;
}

// --- Inputs -------------------------------------------------------------

export interface FlightRiskInput {
  flightNumber: string;
  /** null when the Flight Agent has never polled this flight. */
  status: string | null;
  delayMinutes: number | null;
  /** Minutes from the scoring instant to scheduled departure. Negative = already departed. */
  minutesToDeparture: number;
}

export interface WeatherRiskInput {
  city: string;
  condition: string;
  windSpeedKph: number | null;
  precipitationMm: number | null;
  /** Hours since this reading was fetched. null when there is no reading. */
  ageHours: number | null;
}

export interface RiskScoringInput {
  flights: FlightRiskInput[];
  weather: WeatherRiskInput[];
  documentCount: number;
  /** Documents that finished extraction (status READY). */
  readyDocumentCount: number;
  /** Documents with at least one embedded chunk (searchable). */
  indexedDocumentCount: number;
  destinationCount: number;
  travelerCount: number;
}

export interface RiskFactorResult {
  key: keyof typeof RISK_FACTOR_WEIGHTS;
  label: string;
  weight: number;
  /** 0..1 — how much of this factor's weight is at risk. */
  ratio: number;
  /** ratio * weight, rounded to 2dp. */
  points: number;
  /** True when real stored data drove the ratio. False = scored 0 for lack of data, not from safety. */
  dataAvailable: boolean;
  detail: string;
}

export interface RiskScoreResult {
  riskScore: number;
  severity: RiskSeverity;
  confidence: number;
  factors: RiskFactorResult[];
  /** Share of the 100 points that no data could speak to. */
  dataGaps: number;
}

/**
 * Weather readings older than this are excluded from the weather
 * factor. A month-old forecast is not evidence about today's weather,
 * and scoring off it would be inventing risk.
 */
const MAX_WEATHER_AGE_HOURS = 24;

/**
 * Levels below which weather is not yet a travel risk, so the factor
 * scales from these rather than from zero. Without them a linear
 * from-zero curve makes an 8 kph breeze a nonzero risk, which is the
 * invented-metric failure this whole engine exists to avoid — weather
 * only contributes once a reading is genuinely outside ordinary
 * conditions. These are documented operational thresholds, not
 * forecasts: the numbers come from the provider, the judgement about
 * what counts as "ordinary" is ours and stated here.
 */
const WIND_RISK_FLOOR_KPH = 30;
const WIND_RISK_CEILING_KPH = 80;
const PRECIPITATION_RISK_FLOOR_MM = 2;
const PRECIPITATION_RISK_CEILING_MM = 25;

/** Linear 0..1 between a documented floor and ceiling. */
function scaleBetween(value: number, floor: number, ceiling: number): number {
  if (value <= floor) return 0;
  return Math.min((value - floor) / (ceiling - floor), 1);
}

/** Cancelled/diverted are total disruption; delays scale with magnitude. */
function flightDisruptionFactor(flights: FlightRiskInput[]): RiskFactorResult {
  const weight = RISK_FACTOR_WEIGHTS.flightDisruption;
  const base = { key: "flightDisruption" as const, label: "Flight disruption", weight };

  if (flights.length === 0) {
    return {
      ...base,
      ratio: 0,
      points: 0,
      dataAvailable: false,
      detail: "No flights on this trip, so there is no flight status to score.",
    };
  }

  const scored = flights.filter((flight) => flight.status !== null);
  if (scored.length === 0) {
    return {
      ...base,
      ratio: 0,
      points: 0,
      dataAvailable: false,
      detail: `${flights.length} flight(s) recorded, but none has ever been checked for status.`,
    };
  }

  // Worst flight drives the ratio — a single cancelled flight dominates
  // the operational picture regardless of how many others are fine.
  let worst = 0;
  const drivers: string[] = [];

  for (const flight of scored) {
    const status = flight.status as string;
    let ratio = 0;

    if (status === "CANCELLED" || status === "DIVERTED") {
      ratio = 1;
    } else if (status === "DELAYED") {
      // 15 minutes is the smallest delay worth calling a delay at all;
      // 6 hours saturates the factor.
      const minutes = Math.max(flight.delayMinutes ?? 15, 15);
      ratio = Math.min((minutes - 15) / (360 - 15), 1);
    } else if (status === "UNKNOWN") {
      // Genuinely unknown to the provider — a mild risk of its own, not
      // a disruption and not the same as having no data at all.
      ratio = 0.25;
    }

    if (ratio > worst) {
      worst = ratio;
      drivers.length = 0;
      if (status === "DELAYED" && flight.delayMinutes !== null) {
        drivers.push(`Flight ${flight.flightNumber} is delayed ${flight.delayMinutes} minutes.`);
      } else {
        drivers.push(`Flight ${flight.flightNumber} is ${status.toLowerCase()}.`);
      }
    }
  }

  // Flights never polled are a real, separate readiness gap — reported
  // honestly rather than scored as disruption they didn't cause.
  const unchecked = flights.length - scored.length;
  const uncheckedNote = unchecked > 0 ? ` ${unchecked} flight(s) have no status data yet.` : "";
  const cleanNote =
    drivers.length === 0
      ? `All ${scored.length} checked flight(s) are on schedule.`
      : drivers.join(" ");

  return {
    ...base,
    ratio: worst,
    points: round2(worst * weight),
    dataAvailable: true,
    detail: cleanNote + uncheckedNote,
  };
}

/**
 * Weather only contributes when a *fresh enough* real reading crosses a
 * documented threshold. Ordinary conditions score zero — "it is cloudy
 * in Lisbon" is not a risk, and inflating it would be the invented-metric
 * failure the brief forbids.
 */
function weatherSeverityFactor(weather: WeatherRiskInput[]): RiskFactorResult {
  const weight = RISK_FACTOR_WEIGHTS.weatherSeverity;
  const base = { key: "weatherSeverity" as const, label: "Weather severity", weight };

  if (weather.length === 0) {
    return {
      ...base,
      ratio: 0,
      points: 0,
      dataAvailable: false,
      detail: "No weather readings recorded for this trip yet.",
    };
  }

  const readings = weather.filter((reading) => reading.ageHours !== null);
  if (readings.length === 0) {
    return {
      ...base,
      ratio: 0,
      points: 0,
      dataAvailable: false,
      detail: "Weather was recorded but no reading has a timestamp to judge.",
    };
  }

  let worst = 0;
  const drivers: string[] = [];

  for (const reading of readings) {
    const age = reading.ageHours as number;
    if (age > MAX_WEATHER_AGE_HOURS) {
      drivers.push(
        `${reading.city}: latest reading is ${Math.round(age)}h old, so it was not scored.`,
      );
      continue;
    }

    // Thresholds in the provider's own units: kph and mm.
    const windRisk =
      reading.windSpeedKph === null
        ? 0
        : scaleBetween(reading.windSpeedKph, WIND_RISK_FLOOR_KPH, WIND_RISK_CEILING_KPH);
    const rainRisk =
      reading.precipitationMm === null
        ? 0
        : scaleBetween(
            reading.precipitationMm,
            PRECIPITATION_RISK_FLOOR_MM,
            PRECIPITATION_RISK_CEILING_MM,
          );
    const ratio = Math.max(windRisk, rainRisk);

    if (ratio > worst) {
      worst = ratio;
      drivers.length = 0;
      if (ratio === 0) {
        drivers.push(`${reading.city}: ${reading.condition}, within normal limits.`);
      } else if (windRisk >= rainRisk && reading.windSpeedKph !== null) {
        drivers.push(`${reading.city}: wind at ${reading.windSpeedKph} kph.`);
      } else {
        drivers.push(`${reading.city}: ${reading.precipitationMm} mm precipitation.`);
      }
    }
  }

  // Ordinary conditions are still a real finding — say so, rather than
  // leaving the factor with an empty explanation.
  const cleanNote =
    drivers.length === 0
      ? `${readings.length} fresh reading(s), all within normal limits.`
      : drivers.join(" ");

  return {
    ...base,
    ratio: worst,
    points: round2(worst * weight),
    dataAvailable: readings.length > 0,
    detail: cleanNote,
  };
}

/**
 * How close the next departure is, bounded to a 72h horizon: a delay
 * two months out is not the operational problem a delay tonight is.
 */
function scheduleProximityFactor(flights: FlightRiskInput[]): RiskFactorResult {
  const weight = RISK_FACTOR_WEIGHTS.scheduleProximity;
  const base = { key: "scheduleProximity" as const, label: "Schedule proximity", weight };

  if (flights.length === 0) {
    return {
      ...base,
      ratio: 0,
      points: 0,
      dataAvailable: false,
      detail: "No flights scheduled, so there is no departure to approach.",
    };
  }

  // Only departures still ahead of us count; a flight that already took
  // off is in the past and can't be approached.
  const upcoming = flights
    .map((flight) => flight.minutesToDeparture)
    .filter((minutes) => minutes > 0);
  if (upcoming.length === 0) {
    return {
      ...base,
      ratio: 0,
      points: 0,
      dataAvailable: false,
      detail: "Every flight on this trip has already departed.",
    };
  }

  const soonest = Math.min(...upcoming);
  const ratio = Math.max(0, 1 - soonest / (72 * 60));

  return {
    ...base,
    ratio,
    points: round2(ratio * weight),
    dataAvailable: true,
    detail:
      soonest < 60 * 60
        ? `Next departure is in ${Math.round(soonest)} minutes.`
        : `Next departure is in about ${Math.round(soonest / 60)} hours.`,
  };
}

/**
 * Readiness, not disruption: a trip with no documents — or documents
 * that were never extracted or indexed — has less verified ground truth,
 * which is a modest risk in its own right.
 */
function documentReadinessFactor(input: RiskScoringInput): RiskFactorResult {
  const weight = RISK_FACTOR_WEIGHTS.documentReadiness;
  const base = { key: "documentReadiness" as const, label: "Document readiness", weight };

  if (input.documentCount === 0) {
    return {
      ...base,
      ratio: 0.5,
      points: round2(0.5 * weight),
      dataAvailable: false,
      detail: "No documents attached to this trip.",
    };
  }

  // Unready and unindexed each cost half the factor.
  const unreadyRatio = (input.documentCount - input.readyDocumentCount) / input.documentCount;
  const unindexedRatio = (input.documentCount - input.indexedDocumentCount) / input.documentCount;
  const ratio = Math.min((unreadyRatio + unindexedRatio) / 2, 1);

  return {
    ...base,
    ratio,
    points: round2(ratio * weight),
    dataAvailable: true,
    detail: `${input.readyDocumentCount}/${input.documentCount} extracted, ${input.indexedDocumentCount}/${input.documentCount} indexed for search.`,
  };
}

/** An itinerary with no destinations or travelers isn't scorable as ready. */
function itineraryCompletenessFactor(input: RiskScoringInput): RiskFactorResult {
  const weight = RISK_FACTOR_WEIGHTS.itineraryCompleteness;
  const base = {
    key: "itineraryCompleteness" as const,
    label: "Itinerary completeness",
    weight,
  };

  if (input.destinationCount === 0) {
    return {
      ...base,
      ratio: 1,
      points: weight,
      dataAvailable: true,
      detail: "No destinations on this trip.",
    };
  }

  const ratio = input.travelerCount === 0 ? 0.5 : 0;

  return {
    ...base,
    ratio,
    points: round2(ratio * weight),
    dataAvailable: true,
    detail:
      input.travelerCount === 0
        ? "No travelers on this trip."
        : `${input.destinationCount} destination(s) and ${input.travelerCount} traveler(s) recorded.`,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Confidence is how much of the model had real data behind it — the
 * share of factors that could actually be scored. It is deliberately a
 * statement about evidence coverage, not a statistical probability: with
 * everything checked it is 1, and with nothing checked it is 0, which
 * is the honest report.
 */
function confidenceFor(factors: RiskFactorResult[]): number {
  if (factors.length === 0) return 0;
  const scored = factors.filter((factor) => factor.dataAvailable).length;
  return round2(scored / factors.length);
}

export function scoreTripRisk(input: RiskScoringInput): RiskScoreResult {
  const factors = [
    flightDisruptionFactor(input.flights),
    weatherSeverityFactor(input.weather),
    scheduleProximityFactor(input.flights),
    documentReadinessFactor(input),
    itineraryCompletenessFactor(input),
  ];

  const raw = factors.reduce((total, factor) => total + factor.ratio * factor.weight, 0);
  const riskScore = Math.min(Math.max(Math.round(raw), 0), TOTAL_RISK_WEIGHT);

  const disruption = factors.find((factor) => factor.key === "flightDisruption");
  const tripCannotProceed = disruption?.ratio === 1;
  const severity = tripCannotProceed
    ? maxSeverity(severityForScore(riskScore), "CRITICAL")
    : severityForScore(riskScore);

  return {
    riskScore,
    severity,
    confidence: confidenceFor(factors),
    factors,
    dataGaps: round2(
      factors.reduce((total, factor) => total + (factor.dataAvailable ? 0 : factor.weight), 0),
    ),
  };
}
