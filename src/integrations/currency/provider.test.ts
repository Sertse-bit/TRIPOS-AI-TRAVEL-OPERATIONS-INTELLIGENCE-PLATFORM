import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExchangeRateCurrencyProvider,
  FixerCurrencyProvider,
  MockCurrencyProvider,
} from "@/integrations/currency/provider";
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
