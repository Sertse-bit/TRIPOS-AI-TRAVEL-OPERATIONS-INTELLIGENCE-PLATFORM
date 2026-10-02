import { z } from "zod";
import { env } from "@/config/env";
import { ProviderError } from "@/shared/errors";
import { type ExternalProvider, fetchJson } from "@/integrations/types";
import { withResilience } from "@/infrastructure/resilience";

export interface NormalizedExchangeRate {
  base: string;
  target: string;
  rate: number;
  asOf: string;
}

export interface CurrencyProvider extends ExternalProvider {
  getExchangeRate(base: string, target: string): Promise<NormalizedExchangeRate>;
}

// --- Real adapters ---------------------------------------------------------
//
// Two genuinely independent vendors implementing the same interface —
// this is what proves the abstraction is real, not decorative (brief:
// "the domain layer must not depend directly on vendor SDK details").
// The generic retry/fallback *orchestration* between them belongs to
// Phase 6 (resilience), not here — this phase only defines the two
// interchangeable adapters.
//
// Both verified against real documented responses as of 2026-08-27
// (marketplace.apilayer.com/fixer-api, davidwalsh.name, omi.me), and
// then AGAIN against the live endpoints with this project's actual
// credentials on 2026-10-02 — which is what actually settled the auth
// convention question the earlier doc-only review could not:
//
//  - Fixer: the supplied credential works on the classic
//    `data.fixer.io/api/latest?access_key=` endpoint (HTTP 200, real
//    rates) and is REJECTED by APILayer's unified `api.apilayer.com/fixer`
//    gateway (HTTP 401 "Invalid authentication credentials"). The first
//    version of this adapter used the gateway because APILayer's docs
//    point there; live evidence overruled it.
//
//    One live caveat, observed 2026-10-02: this Fixer tier only allows
//    EUR as the base, answering HTTP 400
//    `base_currency_access_restricted` for anything else (e.g. USD→EUR).
//    That is not an adapter bug and is NOT swallowed — it surfaces as a
//    real ProviderError, and the Phase 6 resilient wrapper fails over to
//    CurrencyLayer, which returned the rate. Both halves of the
//    dual-vendor design were exercised live because of this.
//  - The second credential (`EXCHANGERATE_API_KEY`) is a **CurrencyLayer**
//    key, not an `exchangerates_data` one: the APILayer gateway returns
//    401 for it, exchangerate-api.com's v6 reports `invalid-key`, and
//    `api.currencylayer.com/live` returns HTTP 200 with real quotes. The
//    adapter therefore targets CurrencyLayer — the provider name
//    ("exchangerate") is kept so health/observability identity stays
//    stable, and the endpoint follows the credential.
//
// CurrencyLayer's free tier ignores `symbols` and returns every pair, so
// the parser reads the one pair it asked for out of `quotes` rather than
// assuming the response was filtered.

const successRateSchema = z.object({
  success: z.literal(true),
  timestamp: z.number(),
  base: z.string(),
  rates: z.record(z.string(), z.number()),
});

const errorRateSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.union([z.number(), z.string()]).optional(),
    info: z.string().optional(),
  }),
});

function parseRateResponse(
  providerName: string,
  raw: unknown,
  target: string,
): NormalizedExchangeRate {
  const errorParsed = errorRateSchema.safeParse(raw);
  if (errorParsed.success) {
    throw new ProviderError(
      providerName,
      errorParsed.data.error.info ?? `${providerName} returned an error.`,
    );
  }

  const parsed = successRateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProviderError(
      providerName,
      `${providerName} response did not match the expected shape.`,
      {
        issues: parsed.error.issues,
      },
    );
  }

  const rate = parsed.data.rates[target];
  if (rate === undefined) {
    throw new ProviderError(providerName, `${providerName} did not return a rate for ${target}.`);
  }

  return {
    base: parsed.data.base,
    target,
    rate,
    asOf: new Date(parsed.data.timestamp * 1000).toISOString(),
  };
}

export class FixerCurrencyProvider implements CurrencyProvider {
  readonly providerName = "fixer";

  async getExchangeRate(base: string, target: string): Promise<NormalizedExchangeRate> {
    if (!env.FIXER_API_KEY) {
      throw new ProviderError(this.providerName, "Fixer API key is not configured.");
    }
    // `data.fixer.io?access_key=`, not the APILayer gateway: verified
    // live on 2026-10-02 — this credential gets HTTP 200 here and 401 at
    // api.apilayer.com/fixer (see the header comment).
    const url = new URL("https://data.fixer.io/api/latest");
    url.searchParams.set("access_key", env.FIXER_API_KEY);
    url.searchParams.set("base", base);
    url.searchParams.set("symbols", target);

    const raw = await fetchJson(this.providerName, url.toString());
    return parseRateResponse(this.providerName, raw, target);
  }
}

/**
 * CurrencyLayer's response shape, which differs from Fixer's: `source`
 * (not `base`) and `quotes` keyed by the concatenated pair ("EURUSD")
 * rather than a flat `rates` map keyed by the target alone. Observed
 * live on 2026-10-02, not guessed.
 */
const currencylayerSuccessSchema = z.object({
  success: z.literal(true),
  timestamp: z.number(),
  source: z.string(),
  quotes: z.record(z.string(), z.number()),
});

function parseCurrencylayerResponse(
  providerName: string,
  raw: unknown,
  target: string,
): NormalizedExchangeRate {
  const errorParsed = errorRateSchema.safeParse(raw);
  if (errorParsed.success) {
    throw new ProviderError(
      providerName,
      errorParsed.data.error.info ?? `${providerName} returned an error.`,
    );
  }

  const parsed = currencylayerSuccessSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProviderError(
      providerName,
      `${providerName} response did not match the expected shape.`,
      {
        issues: parsed.error.issues,
      },
    );
  }

  const rate = parsed.data.quotes[`${parsed.data.source}${target}`];
  if (rate === undefined) {
    throw new ProviderError(providerName, `${providerName} did not return a rate for ${target}.`);
  }

  return {
    base: parsed.data.source,
    target,
    rate,
    asOf: new Date(parsed.data.timestamp * 1000).toISOString(),
  };
}

export class ExchangeRateCurrencyProvider implements CurrencyProvider {
  readonly providerName = "exchangerate";

  async getExchangeRate(base: string, target: string): Promise<NormalizedExchangeRate> {
    if (!env.EXCHANGERATE_API_KEY) {
      throw new ProviderError(this.providerName, "ExchangeRate API key is not configured.");
    }
    // CurrencyLayer (see the header comment): verified live on
    // 2026-10-02. `symbols` is passed for the paid tiers that honour it;
    // the free tier returns every pair and the parser selects ours.
    const url = new URL("https://api.currencylayer.com/live");
    url.searchParams.set("access_key", env.EXCHANGERATE_API_KEY);
    url.searchParams.set("source", base);
    url.searchParams.set("symbols", target);

    const raw = await fetchJson(this.providerName, url.toString());
    return parseCurrencylayerResponse(this.providerName, raw, target);
  }
}

// --- Mock adapter ------------------------------------------------------

export class MockCurrencyProvider implements CurrencyProvider {
  readonly providerName = "mock-currency";

  async getExchangeRate(base: string, target: string): Promise<NormalizedExchangeRate> {
    return { base, target, rate: 1.0, asOf: new Date().toISOString() };
  }
}

// --- Resilient wrapper -----------------------------------------------
//
// This is the fallback composition Phase 5 deliberately deferred: if
// Fixer fails (not just "isn't configured" -- an actual failed call),
// retry it, and if it's still failing, fail over to ExchangeRate as a
// genuinely different vendor. Only meaningful when BOTH keys are
// configured; with just one, there's no second vendor to fail over to.
//
// Exchange rates for these tiers typically update once daily, so a
// 1-hour fresh window is generous, and stale data is kept for a full 24
// hours past that -- a day-old rate is still a reasonable basis for a
// travel budget estimate in degraded mode.

class ResilientCurrencyProvider implements CurrencyProvider {
  readonly providerName: string;

  constructor(
    private readonly primary: CurrencyProvider,
    private readonly fallback?: CurrencyProvider,
  ) {
    this.providerName = primary.providerName;
  }

  async getExchangeRate(base: string, target: string): Promise<NormalizedExchangeRate> {
    const result = await withResilience({
      providerName: this.primary.providerName,
      fetchFn: () => this.primary.getExchangeRate(base, target),
      fallbackFn: this.fallback ? () => this.fallback!.getExchangeRate(base, target) : undefined,
      fallbackProviderName: this.fallback?.providerName,
      cacheKey: `resilience:currency:${base}:${target}`,
      freshTtlMs: 60 * 60_000,
      staleTtlMs: 24 * 60 * 60_000,
    });
    return result.data;
  }
}

// --- Factory -------------------------------------------------------------

let cachedProvider: CurrencyProvider | null = null;

export function getCurrencyProvider(): CurrencyProvider {
  if (!cachedProvider) {
    if (env.FIXER_API_KEY && env.EXCHANGERATE_API_KEY) {
      cachedProvider = new ResilientCurrencyProvider(
        new FixerCurrencyProvider(),
        new ExchangeRateCurrencyProvider(),
      );
    } else if (env.FIXER_API_KEY) {
      cachedProvider = new ResilientCurrencyProvider(new FixerCurrencyProvider());
    } else if (env.EXCHANGERATE_API_KEY) {
      cachedProvider = new ResilientCurrencyProvider(new ExchangeRateCurrencyProvider());
    } else {
      cachedProvider = new MockCurrencyProvider();
    }
  }
  return cachedProvider;
}

export function resetCurrencyProviderCache(): void {
  cachedProvider = null;
}
