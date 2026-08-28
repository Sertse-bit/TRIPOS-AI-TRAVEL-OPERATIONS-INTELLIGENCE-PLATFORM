import { afterEach, describe, expect, it, vi } from "vitest";
import { AviationstackProvider, MockAviationProvider } from "@/integrations/aviation/provider";
import { ProviderError } from "@/shared/errors";

// This fixture mirrors a REAL aviationstack /v1/flights response,
// verified via multiple independent public sources (GitHub
// apilayer/aviationstack issue #5, tutorialsteacher.com, dev.to) as of
// 2026-08-27 — not invented from assumption. See provider.ts's doc
// comment for sources.
const REALISTIC_AVIATIONSTACK_RESPONSE = {
  pagination: { limit: 100, offset: 0, count: 1, total: 1 },
  data: [
    {
      flight_date: "2026-09-10",
      flight_status: "active",
      departure: {
        airport: "Bole International",
        timezone: "Africa/Addis_Ababa",
        iata: "ADD",
        icao: "HAAB",
        terminal: "2",
        gate: "12",
        delay: 15,
        scheduled: "2026-09-10T08:00:00+00:00",
        estimated: "2026-09-10T08:15:00+00:00",
        actual: null,
        estimated_runway: "2026-09-10T08:15:00+00:00",
        actual_runway: null,
      },
      arrival: {
        airport: "Dubai International",
        timezone: "Asia/Dubai",
        iata: "DXB",
        icao: "OMDB",
        terminal: "1",
        gate: null,
        baggage: null,
        delay: null,
        scheduled: "2026-09-10T13:30:00+00:00",
        estimated: "2026-09-10T13:45:00+00:00",
        actual: null,
        estimated_runway: null,
        actual_runway: null,
      },
      airline: { name: "Ethiopian Airlines", iata: "ET", icao: "ETH" },
      flight: { number: "602", iata: "ET602", icao: "ETH602", codeshared: null },
      aircraft: null,
      live: null,
    },
  ],
};

describe("AviationstackProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes a realistic Aviationstack response correctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => REALISTIC_AVIATIONSTACK_RESPONSE,
      }),
    );

    const provider = new AviationstackProvider();
    const result = await provider.getFlightStatus("ET602");

    expect(result).not.toBeNull();
    expect(result?.flightStatus).toBe("active");
    expect(result?.airline.name).toBe("Ethiopian Airlines");
    expect(result?.flight.iata).toBe("ET602");
    expect(result?.departure.iata).toBe("ADD");
    expect(result?.departure.delayMinutes).toBe(15);
    expect(result?.arrival.iata).toBe("DXB");
    expect(result?.arrival.delayMinutes).toBeNull();
  });

  it("returns null when no flight matches (empty data array)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ pagination: { limit: 100, offset: 0, count: 0, total: 0 }, data: [] }),
      }),
    );

    const provider = new AviationstackProvider();
    expect(await provider.getFlightStatus("ZZ9999")).toBeNull();
  });

  it("normalizes an unrecognized flight_status value to 'unknown' rather than crashing", async () => {
    const weirdResponse = {
      ...REALISTIC_AVIATIONSTACK_RESPONSE,
      data: [
        { ...REALISTIC_AVIATIONSTACK_RESPONSE.data[0], flight_status: "some_new_status_value" },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => weirdResponse }),
    );

    const provider = new AviationstackProvider();
    const result = await provider.getFlightStatus("ET602");
    expect(result?.flightStatus).toBe("unknown");
  });

  it("throws ProviderError on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: "invalid_access_key" } }),
      }),
    );

    const provider = new AviationstackProvider();
    await expect(provider.getFlightStatus("ET602")).rejects.toBeInstanceOf(ProviderError);
  });

  it("throws ProviderError when the response doesn't match the expected shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ unexpected: "shape" }) }),
    );

    const provider = new AviationstackProvider();
    await expect(provider.getFlightStatus("ET602")).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("MockAviationProvider", () => {
  it("returns clearly-labeled deterministic fixture data", async () => {
    const provider = new MockAviationProvider();
    const result = await provider.getFlightStatus("XX123");
    expect(result.airline.name).toContain("Mock");
    expect(result.flight.iata).toBe("XX123");
  });
});
