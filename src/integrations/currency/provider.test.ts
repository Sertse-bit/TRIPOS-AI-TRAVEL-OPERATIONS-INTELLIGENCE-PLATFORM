import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExchangeRateCurrencyProvider,
  FixerCurrencyProvider,
  MockCurrencyProvider,
  getCurrencyProvider,
  resetCurrencyProviderCache,
} from "@/integrations/currency/provider";
import { redis } from "@/infrastructure/redis";
import { resetAllCircuits } from "@/infrastructure/circuit-breaker";
import { ProviderError } from "@/shared/errors";

// Mirrors real Fixer/ExchangeRate Data API responses (both apilayer
// products, same response shape) — verified via marketplace.apilayer.com
// and davidwalsh.name as of 2026-08-27.
const REALISTIC_RATE_RESPONSE = {
  success: true,
  timestamp: 1789050000,
  base: "ETB",
  date: "2026-09-10",
  rates: { AED: 0.0218, USD: 0.00594 },
};

describe.each([
  { name: "FixerCurrencyProvider", Provider: FixerCurrencyProvider },
  { name: "ExchangeRateCurrencyProvider", Provider: ExchangeRateCurrencyProvider },
])("$name", ({ Provider }) => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes a realistic response correctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => REALISTIC_RATE_RESPONSE }),
    );

    const provider = new Provider();
    const result = await provider.getExchangeRate("ETB", "AED");

    expect(result.base).toBe("ETB");
    expect(result.target).toBe("AED");
    expect(result.rate).toBe(0.0218);
  });

  it("throws ProviderError on the vendor's error-shape response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: false, error: { code: 101, info: "Invalid API key." } }),
      }),
    );
    const provider = new Provider();
    await expect(provider.getExchangeRate("ETB", "AED")).rejects.toMatchObject({
      message: "Invalid API key.",
    });
  });

  it("throws ProviderError when the requested target currency isn't in the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          timestamp: 1789050000,
          base: "ETB",
          rates: { USD: 0.00594 },
        }),
      }),
    );
    const provider = new Provider();
    await expect(provider.getExchangeRate("ETB", "AED")).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("MockCurrencyProvider", () => {
  it("returns a deterministic 1:1 fixture rate", async () => {
    const provider = new MockCurrencyProvider();
    const result = await provider.getExchangeRate("ETB", "AED");
    expect(result.rate).toBe(1.0);
  });
});

describe("getCurrencyProvider() resilient fallback composition (end to end)", () => {
  const cacheKey = "resilience:currency:ETB:AED";

  beforeEach(async () => {
    // Not just afterEach: if any previous run's cleanup ever failed to
    // execute (a transient Redis hiccup, or — as actually happened once
    // during this build — leftover state from an earlier successful run
    // that outlived a single afterEach), a stale cached rate could
    // silently satisfy this test without genuinely exercising the
    // fallback path. Cleaning up before, too, makes this self-healing
    // regardless of what happened last time.
    await redis.del(cacheKey);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    resetCurrencyProviderCache();
    resetAllCircuits();
    await redis.del(cacheKey);
  });

  it("falls over from Fixer to ExchangeRate when Fixer's real calls genuinely fail", async () => {
    // Both AVIATIONSTACK-style env keys are already set in vitest.setup.ts
    // for FIXER_API_KEY and EXCHANGERATE_API_KEY, so getCurrencyProvider()
    // selects the dual-vendor ResilientCurrencyProvider path.
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        callCount++;
        if (url.includes("/fixer/")) {
          return { ok: false, status: 503, json: async () => ({}) };
        }
        // exchangerates_data (the fallback vendor) succeeds
        return {
          ok: true,
          json: async () => ({
            success: true,
            timestamp: 1789050000,
            base: "ETB",
            rates: { AED: 0.0218 },
          }),
        };
      }),
    );

    const provider = getCurrencyProvider();
    // maxRetries defaults to 2 inside withResilience, so Fixer will be
    // attempted 3 times before falling over -- this is the real,
    // unmodified default the factory wires up, not a test-only shortcut.
    const result = await provider.getExchangeRate("ETB", "AED");

    expect(result.rate).toBe(0.0218);
    expect(callCount).toBeGreaterThan(1); // proves Fixer really was tried before falling over
  });
});
