import { describe, expect, it } from "vitest";
import {
  apiHealthTone,
  circuitStateTone,
  documentStatusTone,
  flightStatusTone,
  recommendationStatusTone,
  riskSeverityTone,
  tripStatusTone,
  type Tone,
} from "@/components/tone";

/**
 * The tone mappings (Phase 27) are how every status in the product reads:
 * a wrong mapping does not crash anything — it paints a DOWN provider
 * green. Each real enum value from the Prisma schema therefore has a
 * pinned, non-neutral tone, and unknown values are pinned too, so a new
 * enum value forces an explicit decision here instead of silently
 * rendering as "neutral".
 */

/** Actors: the value is the real Prisma enum member; the tone is the pin. */
function expectMapping(fn: (value: string) => Tone, cases: Array<[string, Tone]>): void {
  for (const [value, tone] of cases) {
    expect(fn(value), value).toBe(tone);
  }
}

describe("tripStatusTone", () => {
  it("maps every TripStatus value", () => {
    expectMapping(tripStatusTone, [
      ["PLANNING", "neutral"],
      ["UPCOMING", "warn"],
      ["ACTIVE", "ok"],
      ["COMPLETED", "ok"],
      ["CANCELLED", "alert"],
    ]);
  });

  it("leaves unknown statuses neutral rather than guessing", () => {
    expect(tripStatusTone("SOMETHING_NEW")).toBe("neutral");
  });
});

describe("flightStatusTone", () => {
  it("maps every FlightStatus value", () => {
    expectMapping(flightStatusTone, [
      ["UNKNOWN", "neutral"],
      ["SCHEDULED", "neutral"],
      ["DELAYED", "warn"],
      ["LANDED", "ok"],
      ["COMPLETED", "ok"],
      ["CANCELLED", "alert"],
    ]);
  });
});

describe("documentStatusTone", () => {
  it("maps every DocumentStatus value", () => {
    expectMapping(documentStatusTone, [
      ["UPLOADED", "neutral"],
      ["PROCESSING", "warn"],
      ["READY", "ok"],
      ["FAILED", "alert"],
    ]);
  });
});

describe("riskSeverityTone", () => {
  it("maps all four severity bands, high and critical together", () => {
    expectMapping(riskSeverityTone, [
      ["LOW", "ok"],
      ["MEDIUM", "warn"],
      ["HIGH", "alert"],
      ["CRITICAL", "alert"],
    ]);
  });
});

describe("apiHealthTone", () => {
  it("maps the ApiHealthStatus values the resilience layer writes", () => {
    expectMapping(apiHealthTone, [
      ["OPERATIONAL", "ok"],
      ["DEGRADED", "warn"],
      ["DOWN", "alert"],
    ]);
  });
});

describe("circuitStateTone", () => {
  it("maps all three breaker states, with CLOSED healthy (inverted naming)", () => {
    expectMapping(circuitStateTone, [
      ["CLOSED", "ok"],
      ["HALF_OPEN", "warn"],
      ["OPEN", "alert"],
    ]);
  });
});

describe("recommendationStatusTone", () => {
  it("maps the recommendation lifecycle", () => {
    expectMapping(recommendationStatusTone, [
      ["PENDING", "warn"],
      ["ACKNOWLEDGED", "ok"],
      ["DISMISSED", "neutral"],
    ]);
  });
});
