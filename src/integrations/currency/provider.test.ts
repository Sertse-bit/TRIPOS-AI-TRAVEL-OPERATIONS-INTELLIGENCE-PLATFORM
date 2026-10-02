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

// Shapes below are the ones this project's ACTUAL credentials return,
// observed live on 2026-10-02 (both adapters were fixed after that check
// caught a gateway assumption and a shape assumption — see the header
// comment in provider.ts). Fixer and CurrencyLayer are different
// products with different response shapes, which is why this is no
// longer one shared fixture for both.
const REALISTIC_FIXER_RESPONSE = {
  success: true,
  timestamp: 1790936345,
  base: "EUR",
  date: "2026-10-02",
  rates: { USD: 1.123949, AED: 4.12418 },
};

const REALISTIC_CURRENCYLAYER_RESPONSE = {
  success: true,
  timestamp: 1790939105,
  source: "EUR",
  // Free tier ignores `symbols` and returns every pair, keyed by the
  // concatenated pair — hence the extra pairs the adapter must ignore.
  quotes: { EURUSD: 1.123949, EURAED: 4.12418, EURAFN: 72.994161 },
};

describe("FixerCurrencyProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes a realistic response correctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => REALISTIC_FIXER_RESPONSE }),
    );

    const provider = new FixerCurrencyProvider();
    const result = await provider.getExchangeRate("EUR", "AED");

    expect(result.base).toBe("EUR");
    expect(result.target).toBe("AED");
    expect(result.rate).toBe(4.12418);
  });

  it("calls the endpoint this project's credential actually works on", async () => {
    // Regression guard for the bug live verification found: the APILayer
    // gateway returns 401 for this key, while data.fixer.io returns 200.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => REALISTIC_FIXER_RESPONSE,
    });
    vi.stubGlobal("fetch", fetchMock);

    await new FixerCurrencyProvider().getExchangeRate("EUR", "USD");

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url.startsWith("https://data.fixer.io/api/latest")).toBe(true);
    expect(url).toContain("access_key=");
    expect(url).not.toContain("api.apilayer.com");
  });

  it("throws ProviderError on the vendor's error-shape response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: false, error: { code: 101, info: "Invalid API key." } }),
      }),
    );
    await expect(new FixerCurrencyProvider().getExchangeRate("EUR", "AED")).rejects.toMatchObject({
      message: "Invalid API key.",
    });
  });

  it("throws ProviderError when the requested target currency isn't in the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, timestamp: 1, base: "EUR", rates: { USD: 1.1 } }),
      }),
    );
    await expect(new FixerCurrencyProvider().getExchangeRate("EUR", "AED")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

describe("ExchangeRateCurrencyProvider (CurrencyLayer)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the requested pair out of the concatenated-key quotes map", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => REALISTIC_CURRENCYLAYER_RESPONSE,
      }),
    );

    const provider = new ExchangeRateCurrencyProvider();
    const result = await provider.getExchangeRate("EUR", "AED");

    expect(result.base).toBe("EUR");
    expect(result.target).toBe("AED");
    expect(result.rate).toBe(4.12418);
    // The unrequested pairs in the free tier's response are ignored, not
    // mistaken for the answer.
    expect(result.asOf).toBe(new Date(1790939105 * 1000).toISOString());
  });

  it("calls the endpoint this project's credential actually works on", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => REALISTIC_CURRENCYLAYER_RESPONSE,
    });
    vi.stubGlobal("fetch", fetchMock);

    await new ExchangeRateCurrencyProvider().getExchangeRate("EUR", "USD");

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url.startsWith("https://api.currencylayer.com/live")).toBe(true);
    expect(url).toContain("access_key=");
    // The APILayer exchangerates_data gateway 401s with this credential.
    expect(url).not.toContain("exchangerates_data");
  });

  it("throws ProviderError on the vendor's error-shape response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: false,
          error: { code: 101, type: "invalid_access_key", info: "Invalid API key." },
        }),
      }),
    );
    await expect(
      new ExchangeRateCurrencyProvider().getExchangeRate("EUR", "AED"),
    ).rejects.toMatchObject({ message: "Invalid API key." });
  });

  it("throws ProviderError when the requested pair isn't in quotes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, timestamp: 1, source: "EUR", quotes: { EURUSD: 1.1 } }),
      }),
    );
    await expect(
      new ExchangeRateCurrencyProvider().getExchangeRate("EUR", "AED"),
    ).rejects.toBeInstanceOf(ProviderError);
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
    // Both FIXER_API_KEY and EXCHANGERATE_API_KEY are set in
    // vitest.setup.ts, so getCurrencyProvider() selects the
    // dual-vendor ResilientCurrencyProvider path.
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        callCount++;
        if (url.includes("data.fixer.io")) {
          return { ok: false, status: 503, json: async () => ({}) };
        }
        // CurrencyLayer (the fallback vendor) succeeds — its real shape,
        // with quotes keyed by the concatenated pair.
        return {
          ok: true,
          json: async () => ({
            success: true,
            timestamp: 1789050000,
            source: "ETB",
            quotes: { ETBAED: 0.0218 },
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
