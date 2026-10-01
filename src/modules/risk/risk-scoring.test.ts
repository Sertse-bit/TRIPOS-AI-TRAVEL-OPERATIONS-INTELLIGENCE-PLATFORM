import { describe, expect, it } from "vitest";
import {
  RISK_FACTOR_WEIGHTS,
  SEVERITY_THRESHOLDS,
  TOTAL_RISK_WEIGHT,
  type RiskScoringInput,
  scoreTripRisk,
  severityForScore,
} from "@/modules/risk/risk-scoring";

/**
 * Pure-function tests: no database, no clock. The scoring model is the
 * part of Phase 16 that must be provably deterministic, so it is tested
 * in isolation — a mocked DB here would prove nothing about it.
 */

function baseInput(overrides: Partial<RiskScoringInput> = {}): RiskScoringInput {
  return {
    flights: [],
    weather: [],
    documentCount: 0,
    readyDocumentCount: 0,
    indexedDocumentCount: 0,
    destinationCount: 1,
    travelerCount: 1,
    ...overrides,
  };
}

describe("risk factor weights", () => {
  it("sum to 100 so the score is a percentage of total weight", () => {
    expect(TOTAL_RISK_WEIGHT).toBe(100);
    const sum = Object.values(RISK_FACTOR_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });
});

describe("severityForScore", () => {
  it("maps documented thresholds to documented severities", () => {
    expect(severityForScore(0)).toBe("LOW");
    expect(severityForScore(14)).toBe("LOW");
    expect(severityForScore(15)).toBe("MEDIUM");
    expect(severityForScore(34)).toBe("MEDIUM");
    expect(severityForScore(35)).toBe("HIGH");
    expect(severityForScore(59)).toBe("HIGH");
    expect(severityForScore(60)).toBe("CRITICAL");
    expect(severityForScore(100)).toBe("CRITICAL");
  });

  it("never falls through an uncovered boundary", () => {
    for (let score = 0; score <= 100; score += 1) {
      const covered = SEVERITY_THRESHOLDS.some((t) => score >= t.min);
      expect(covered || score < SEVERITY_THRESHOLDS[SEVERITY_THRESHOLDS.length - 1].min).toBe(true);
      expect(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).toContain(severityForScore(score));
    }
  });

  it("is monotonically non-decreasing across the whole range", () => {
    const order = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
    for (let score = 1; score <= 100; score += 1) {
      expect(order.indexOf(severityForScore(score))).toBeGreaterThanOrEqual(
        order.indexOf(severityForScore(score - 1)),
      );
    }
  });
});

describe("flight disruption factor", () => {
  it("maxes out on a cancelled flight regardless of other flights", () => {
    const result = scoreTripRisk(
      baseInput({
        flights: [
          { flightNumber: "TP1", status: "ON_TIME", delayMinutes: 0, minutesToDeparture: 6000 },
          {
            flightNumber: "TP2",
            status: "CANCELLED",
            delayMinutes: null,
            minutesToDeparture: 6000,
          },
        ],
      }),
    );
    const factor = result.factors.find((f) => f.key === "flightDisruption");
    expect(factor?.ratio).toBe(1);
    expect(factor?.points).toBe(RISK_FACTOR_WEIGHTS.flightDisruption);
    expect(factor?.detail).toContain("cancelled");
  });

  it("scales delay risk with the real delay minutes", () => {
    const small = scoreTripRisk(
      baseInput({
        flights: [
          { flightNumber: "TP1", status: "DELAYED", delayMinutes: 30, minutesToDeparture: 6000 },
        ],
      }),
    );
    const large = scoreTripRisk(
      baseInput({
        flights: [
          { flightNumber: "TP1", status: "DELAYED", delayMinutes: 400, minutesToDeparture: 6000 },
        ],
      }),
    );

    const smallFactor = small.factors.find((f) => f.key === "flightDisruption");
    const largeFactor = large.factors.find((f) => f.key === "flightDisruption");
    expect(largeFactor!.ratio).toBeGreaterThan(smallFactor!.ratio);
    expect(largeFactor!.ratio).toBe(1);
  });

  it("scores zero and says so when flights were never checked", () => {
    const result = scoreTripRisk(
      baseInput({
        flights: [
          { flightNumber: "TP1", status: null, delayMinutes: null, minutesToDeparture: 6000 },
        ],
      }),
    );
    const factor = result.factors.find((f) => f.key === "flightDisruption");
    expect(factor?.dataAvailable).toBe(false);
    expect(factor?.points).toBe(0);
    expect(factor?.detail).toContain("none has ever been checked for status");
    // ...and the un-scored weight is reported as a data gap rather than
    // quietly treated as "no risk".
    expect(result.dataGaps).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(1);
  });

  it("counts an UNKNOWN provider status as mild risk, not zero and not total", () => {
    const factor = scoreTripRisk(
      baseInput({
        flights: [
          { flightNumber: "TP1", status: "UNKNOWN", delayMinutes: null, minutesToDeparture: 6000 },
        ],
      }),
    ).factors.find((f) => f.key === "flightDisruption");
    expect(factor?.ratio).toBeGreaterThan(0);
    expect(factor?.ratio).toBeLessThan(1);
  });
});

describe("weather severity factor", () => {
  it("scores zero for ordinary conditions", () => {
    const factor = scoreTripRisk(
      baseInput({
        weather: [
          { city: "Lisbon", condition: "Clear", windSpeedKph: 8, precipitationMm: 0, ageHours: 1 },
        ],
      }),
    ).factors.find((f) => f.key === "weatherSeverity");
    expect(factor?.ratio).toBe(0);
    expect(factor?.points).toBe(0);
    expect(factor?.dataAvailable).toBe(true);
  });

  it("scales with real wind and precipitation readings", () => {
    const calm = scoreTripRisk(
      baseInput({
        weather: [
          { city: "Porto", condition: "Rain", windSpeedKph: 10, precipitationMm: 1, ageHours: 1 },
        ],
      }),
    ).factors.find((f) => f.key === "weatherSeverity");
    const severe = scoreTripRisk(
      baseInput({
        weather: [
          { city: "Porto", condition: "Storm", windSpeedKph: 90, precipitationMm: 40, ageHours: 1 },
        ],
      }),
    ).factors.find((f) => f.key === "weatherSeverity");
    expect(severe!.ratio).toBe(1);
    expect(severe!.ratio).toBeGreaterThan(calm!.ratio);
    expect(severe!.detail).toContain("Porto");
  });

  it("ignores readings too old to describe current conditions", () => {
    const factor = scoreTripRisk(
      baseInput({
        weather: [
          { city: "Rome", condition: "Clear", windSpeedKph: 5, precipitationMm: 0, ageHours: 200 },
        ],
      }),
    ).factors.find((f) => f.key === "weatherSeverity");
    expect(factor?.ratio).toBe(0);
    expect(factor?.detail).toContain("old");
  });

  it("reports missing readings as a gap, not as good weather", () => {
    const factor = scoreTripRisk(
      baseInput({
        weather: [
          {
            city: "Rome",
            condition: "unknown",
            windSpeedKph: null,
            precipitationMm: null,
            ageHours: null,
          },
        ],
      }),
    ).factors.find((f) => f.key === "weatherSeverity");
    expect(factor?.dataAvailable).toBe(false);
    expect(factor?.points).toBe(0);
  });
});

describe("schedule proximity factor", () => {
  it("rises as departure approaches within the 72h horizon", () => {
    const far = scoreTripRisk(
      baseInput({
        flights: [
          {
            flightNumber: "TP1",
            status: "SCHEDULED",
            delayMinutes: 0,
            minutesToDeparture: 60 * 24 * 200,
          },
        ],
      }),
    ).factors.find((f) => f.key === "scheduleProximity");
    const near = scoreTripRisk(
      baseInput({
        flights: [
          { flightNumber: "TP1", status: "SCHEDULED", delayMinutes: 0, minutesToDeparture: 30 },
        ],
      }),
    ).factors.find((f) => f.key === "scheduleProximity");

    expect(far!.ratio).toBe(0);
    expect(near!.ratio).toBeGreaterThan(far!.ratio);
  });

  it("does not treat already-departed flights as imminent", () => {
    const factor = scoreTripRisk(
      baseInput({
        flights: [
          { flightNumber: "TP1", status: "LANDED", delayMinutes: 0, minutesToDeparture: -600 },
        ],
      }),
    ).factors.find((f) => f.key === "scheduleProximity");
    expect(factor?.ratio).toBe(0);
    expect(factor?.detail).toContain("already departed");
  });
});

describe("document readiness factor", () => {
  it("is fully satisfied when every document is extracted and indexed", () => {
    const factor = scoreTripRisk(
      baseInput({ documentCount: 2, readyDocumentCount: 2, indexedDocumentCount: 2 }),
    ).factors.find((f) => f.key === "documentReadiness");
    expect(factor?.ratio).toBe(0);
  });

  it("penalises documents that never finished extraction or indexing", () => {
    const factor = scoreTripRisk(
      baseInput({ documentCount: 2, readyDocumentCount: 1, indexedDocumentCount: 0 }),
    ).factors.find((f) => f.key === "documentReadiness");
    expect(factor!.ratio).toBeGreaterThan(0);
    expect(factor!.ratio).toBeLessThan(1);
    expect(factor!.detail).toContain("1/2 extracted");
  });
});

describe("itinerary completeness factor", () => {
  it("maxes out when the trip has no destinations at all", () => {
    const factor = scoreTripRisk(baseInput({ destinationCount: 0 })).factors.find(
      (f) => f.key === "itineraryCompleteness",
    );
    expect(factor?.ratio).toBe(1);
  });

  it("scores zero for a trip with destinations and travelers", () => {
    const factor = scoreTripRisk(baseInput({ destinationCount: 2, travelerCount: 3 })).factors.find(
      (f) => f.key === "itineraryCompleteness",
    );
    expect(factor?.ratio).toBe(0);
  });
});

describe("scoreTripRisk", () => {
  it("is deterministic — identical input, identical output", () => {
    const input = baseInput({
      flights: [
        { flightNumber: "TP1", status: "DELAYED", delayMinutes: 90, minutesToDeparture: 120 },
        { flightNumber: "TP2", status: "SCHEDULED", delayMinutes: 0, minutesToDeparture: 6000 },
      ],
      weather: [
        { city: "Porto", condition: "Rain", windSpeedKph: 45, precipitationMm: 5, ageHours: 2 },
      ],
      documentCount: 2,
      readyDocumentCount: 2,
      indexedDocumentCount: 2,
    });
    expect(JSON.stringify(scoreTripRisk(input))).toBe(JSON.stringify(scoreTripRisk(input)));
  });

  it("always lands inside 0..100 with a matching severity", () => {
    const empty = scoreTripRisk(baseInput());
    const worst = scoreTripRisk(
      baseInput({
        flights: [
          { flightNumber: "TP1", status: "CANCELLED", delayMinutes: null, minutesToDeparture: 1 },
        ],
        weather: [
          { city: "X", condition: "Storm", windSpeedKph: 100, precipitationMm: 90, ageHours: 0 },
        ],
        documentCount: 3,
        readyDocumentCount: 0,
        indexedDocumentCount: 0,
        destinationCount: 0,
        travelerCount: 0,
      }),
    );

    for (const result of [empty, worst]) {
      expect(result.riskScore).toBeGreaterThanOrEqual(0);
      expect(result.riskScore).toBeLessThanOrEqual(100);
      expect(severityForScore(result.riskScore)).toBe(result.severity);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
    expect(worst.riskScore).toBe(100);
    expect(worst.severity).toBe("CRITICAL");
  });

  it("makes factor points add up to the reported score", () => {
    const result = scoreTripRisk(
      baseInput({
        flights: [
          { flightNumber: "TP1", status: "DELAYED", delayMinutes: 60, minutesToDeparture: 90 },
        ],
        documentCount: 1,
        readyDocumentCount: 0,
        indexedDocumentCount: 0,
      }),
    );
    const summed = result.factors.reduce((total, f) => total + f.points, 0);
    // Points are rounded per factor, so the total may differ by <1.
    expect(Math.abs(summed - result.riskScore)).toBeLessThan(1);
  });

  it("reports confidence as evidence coverage, not as a probability of danger", () => {
    const fullyCovered = scoreTripRisk(
      baseInput({
        flights: [
          { flightNumber: "TP1", status: "SCHEDULED", delayMinutes: 0, minutesToDeparture: 6000 },
        ],
        weather: [
          { city: "Porto", condition: "Clear", windSpeedKph: 5, precipitationMm: 0, ageHours: 1 },
        ],
        documentCount: 1,
        readyDocumentCount: 1,
        indexedDocumentCount: 1,
      }),
    );
    const nothingKnown = scoreTripRisk(baseInput({ flights: [], weather: [] }));

    expect(fullyCovered.confidence).toBeGreaterThan(nothingKnown.confidence);
    // A clean trip is not more "confident" than a risky one; confidence
    // tracks how much data existed, so a fully-checked calm trip is 1.
    expect(fullyCovered.riskScore).toBe(0);
    expect(fullyCovered.confidence).toBe(1);
  });

  it("always explains itself, even when nothing is wrong", () => {
    // Found live: a trip with everything on schedule stored an EMPTY
    // detail string for its top-weighted factor, which rendered as a
    // blank line in the UI. Zero risk is a real finding and says so.
    const calm = scoreTripRisk(
      baseInput({
        flights: [
          { flightNumber: "TP1", status: "SCHEDULED", delayMinutes: 0, minutesToDeparture: 6000 },
        ],
        weather: [
          { city: "Porto", condition: "Clear", windSpeedKph: 6, precipitationMm: 0, ageHours: 1 },
        ],
        documentCount: 1,
        readyDocumentCount: 1,
        indexedDocumentCount: 1,
      }),
    );
    expect(calm.riskScore).toBe(0);
    for (const factor of calm.factors) {
      expect(factor.detail.trim().length).toBeGreaterThan(0);
    }
    expect(calm.factors.find((f) => f.key === "flightDisruption")?.detail).toContain("on schedule");
    expect(calm.factors.find((f) => f.key === "weatherSeverity")?.detail).toContain(
      "normal limits",
    );
  });

  it("floors severity at CRITICAL when a flight is cancelled, even on an otherwise quiet trip", () => {
    const quietTrip = {
      flights: [
        {
          flightNumber: "TP1",
          status: "CANCELLED" as const,
          delayMinutes: null,
          minutesToDeparture: 60 * 24 * 30,
        },
      ],
      weather: [
        { city: "Rome", condition: "Clear", windSpeedKph: 5, precipitationMm: 0, ageHours: 1 },
      ],
      documentCount: 1,
      readyDocumentCount: 1,
      indexedDocumentCount: 1,
      destinationCount: 1,
      travelerCount: 1,
    };

    const result = scoreTripRisk(quietTrip);

    // The weighted score alone would only say HIGH — the floor is what
    // makes a cancelled flight read as the trip-stopping event it is.
    expect(result.riskScore).toBeLessThan(60);
    expect(result.severity).toBe("CRITICAL");
    expect(severityForScore(result.riskScore)).not.toBe("CRITICAL");
  });

  it("does not apply that floor to a merely delayed flight", () => {
    const result = scoreTripRisk(
      baseInput({
        flights: [
          {
            flightNumber: "TP1",
            status: "DELAYED",
            delayMinutes: 60,
            minutesToDeparture: 60 * 24 * 30,
          },
        ],
        documentCount: 1,
        readyDocumentCount: 1,
        indexedDocumentCount: 1,
      }),
    );
    expect(result.severity).toBe(severityForScore(result.riskScore));
  });

  it("returns every documented factor, with weights intact", () => {
    const result = scoreTripRisk(baseInput());
    expect(result.factors.map((f) => f.key).sort()).toEqual(
      Object.keys(RISK_FACTOR_WEIGHTS).sort(),
    );
    for (const factor of result.factors) {
      expect(factor.weight).toBe(RISK_FACTOR_WEIGHTS[factor.key]);
      expect(factor.detail.length).toBeGreaterThan(0);
    }
  });
});
