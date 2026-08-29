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
// (marketplace.apilayer.com/fixer-api, davidwalsh.name, omi.me). Note the
// auth convention difference: Fixer has migrated to APILayer's unified
// `api.apilayer.com/<product>` gateway with an `apikey` header, while
// older sources still show the legacy `data.fixer.io?access_key=`
// convention — the gateway form is used here since the credentials in
// this project are APILayer marketplace-bundle keys. Re-verify against
// live docs before this is ever run for real.

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
    const url = new URL("https://api.apilayer.com/fixer/latest");
    url.searchParams.set("base", base);
    url.searchParams.set("symbols", target);

    const raw = await fetchJson(this.providerName, url.toString(), {
      headers: { apikey: env.FIXER_API_KEY },
    });
    return parseRateResponse(this.providerName, raw, target);
  }
}

export class ExchangeRateCurrencyProvider implements CurrencyProvider {
  readonly providerName = "exchangerate";

  async getExchangeRate(base: string, target: string): Promise<NormalizedExchangeRate> {
    if (!env.EXCHANGERATE_API_KEY) {
      throw new ProviderError(this.providerName, "ExchangeRate API key is not configured.");
    }
    const url = new URL("https://api.apilayer.com/exchangerates_data/latest");
    url.searchParams.set("base", base);
    url.searchParams.set("symbols", target);

    const raw = await fetchJson(this.providerName, url.toString(), {
      headers: { apikey: env.EXCHANGERATE_API_KEY },
    });
    return parseRateResponse(this.providerName, raw, target);
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
