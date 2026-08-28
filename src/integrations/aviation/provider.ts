import { z } from "zod";
import { env } from "@/config/env";
import { ProviderError } from "@/shared/errors";
import { type ExternalProvider, fetchJson } from "@/integrations/types";

/**
 * Normalized shape every caller works with, regardless of which vendor
 * answered. Field names and structure verified against Aviationstack's
 * actual documented response (cross-checked against multiple independent
 * real API response examples — GitHub issue #5 on apilayer/aviationstack,
 * tutorialsteacher.com, dev.to — as of 2026-08-27, not built from memory
 * alone). Re-verify against live docs before this is ever run for real:
 * https://aviationstack.com/documentation
 */
export interface NormalizedFlightStatus {
  flightDate: string;
  flightStatus:
    "scheduled" | "active" | "landed" | "cancelled" | "incident" | "diverted" | "unknown";
  airline: { name: string | null; iata: string | null };
  flight: { number: string | null; iata: string | null };
  departure: {
    airport: string | null;
    iata: string | null;
    scheduled: string | null;
    estimated: string | null;
    actual: string | null;
    delayMinutes: number | null;
    terminal: string | null;
    gate: string | null;
  };
  arrival: {
    airport: string | null;
    iata: string | null;
    scheduled: string | null;
    estimated: string | null;
    actual: string | null;
    delayMinutes: number | null;
    terminal: string | null;
    gate: string | null;
  };
}

export interface AviationProvider extends ExternalProvider {
  getFlightStatus(flightIata: string): Promise<NormalizedFlightStatus | null>;
}

// --- Real adapter --------------------------------------------------------

const aviationstackFlightSchema = z.object({
  flight_date: z.string(),
  flight_status: z.string(),
  airline: z.object({ name: z.string().nullable(), iata: z.string().nullable() }).nullable(),
  flight: z.object({ number: z.string().nullable(), iata: z.string().nullable() }).nullable(),
  departure: z.object({
    airport: z.string().nullable(),
    iata: z.string().nullable(),
    scheduled: z.string().nullable(),
    estimated: z.string().nullable(),
    actual: z.string().nullable(),
    delay: z.number().nullable(),
    terminal: z.string().nullable(),
    gate: z.string().nullable(),
  }),
  arrival: z.object({
    airport: z.string().nullable(),
    iata: z.string().nullable(),
    scheduled: z.string().nullable(),
    estimated: z.string().nullable(),
    actual: z.string().nullable(),
    delay: z.number().nullable(),
    terminal: z.string().nullable(),
    gate: z.string().nullable(),
  }),
});

const aviationstackResponseSchema = z.object({
  data: z.array(aviationstackFlightSchema),
});

const KNOWN_STATUSES = new Set([
  "scheduled",
  "active",
  "landed",
  "cancelled",
  "incident",
  "diverted",
]);

function normalizeStatus(raw: string): NormalizedFlightStatus["flightStatus"] {
  const lower = raw.toLowerCase();
  return (KNOWN_STATUSES.has(lower) ? lower : "unknown") as NormalizedFlightStatus["flightStatus"];
}

export class AviationstackProvider implements AviationProvider {
  readonly providerName = "aviationstack";

  async getFlightStatus(flightIata: string): Promise<NormalizedFlightStatus | null> {
    if (!env.AVIATIONSTACK_API_KEY) {
      throw new ProviderError(this.providerName, "Aviationstack API key is not configured.");
    }

    // Own dedicated domain + access_key query param — this is
    // Aviationstack's own documented convention, distinct from the
    // apilayer.com/<product> gateway some other APILayer products (e.g.
    // Fixer) have migrated to. Verified across multiple independent
    // sources as of 2026-08-27.
    const url = new URL("https://api.aviationstack.com/v1/flights");
    url.searchParams.set("access_key", env.AVIATIONSTACK_API_KEY);
    url.searchParams.set("flight_iata", flightIata);

    const raw = await fetchJson(this.providerName, url.toString());
    const parsed = aviationstackResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new ProviderError(
        this.providerName,
        "Aviationstack response did not match the expected shape.",
        { issues: parsed.error.issues },
      );
    }

    const flightData = parsed.data.data[0];
    if (!flightData) return null;

    return {
      flightDate: flightData.flight_date,
      flightStatus: normalizeStatus(flightData.flight_status),
      airline: {
        name: flightData.airline?.name ?? null,
        iata: flightData.airline?.iata ?? null,
      },
      flight: {
        number: flightData.flight?.number ?? null,
        iata: flightData.flight?.iata ?? null,
      },
      departure: {
        airport: flightData.departure.airport,
        iata: flightData.departure.iata,
        scheduled: flightData.departure.scheduled,
        estimated: flightData.departure.estimated,
        actual: flightData.departure.actual,
        delayMinutes: flightData.departure.delay,
        terminal: flightData.departure.terminal,
        gate: flightData.departure.gate,
      },
      arrival: {
        airport: flightData.arrival.airport,
        iata: flightData.arrival.iata,
        scheduled: flightData.arrival.scheduled,
        estimated: flightData.arrival.estimated,
        actual: flightData.arrival.actual,
        delayMinutes: flightData.arrival.delay,
        terminal: flightData.arrival.terminal,
        gate: flightData.arrival.gate,
      },
    };
  }
}

// --- Mock adapter ----------------------------------------------------------

/**
 * Documented mock for development/testing when no API key is configured
 * — never presented as real data. Returns a clearly-labeled, deterministic
 * fixture so callers can exercise the full flow (including the Flight
 * Agent's state-comparison logic in Phase 10) without a live credential.
 */
export class MockAviationProvider implements AviationProvider {
  readonly providerName = "mock-aviation";

  async getFlightStatus(flightIata: string): Promise<NormalizedFlightStatus> {
    return {
      flightDate: new Date().toISOString().slice(0, 10),
      flightStatus: "scheduled",
      airline: { name: "Mock Airline (dev fixture)", iata: "MK" },
      flight: { number: "1234", iata: flightIata },
      departure: {
        airport: "Mock Departure Airport",
        iata: "MCK",
        scheduled: new Date(Date.now() + 3600_000).toISOString(),
        estimated: null,
        actual: null,
        delayMinutes: null,
        terminal: "1",
        gate: "A1",
      },
      arrival: {
        airport: "Mock Arrival Airport",
        iata: "MCA",
        scheduled: new Date(Date.now() + 10800_000).toISOString(),
        estimated: null,
        actual: null,
        delayMinutes: null,
        terminal: "2",
        gate: "B2",
      },
    };
  }
}

// --- Factory -----------------------------------------------------------

let cachedProvider: AviationProvider | null = null;

export function getAviationProvider(): AviationProvider {
  cachedProvider ??= env.AVIATIONSTACK_API_KEY
    ? new AviationstackProvider()
    : new MockAviationProvider();
  return cachedProvider;
}

/** Test-only: resets the cached singleton so tests can control which adapter is returned. */
export function resetAviationProviderCache(): void {
  cachedProvider = null;
}
