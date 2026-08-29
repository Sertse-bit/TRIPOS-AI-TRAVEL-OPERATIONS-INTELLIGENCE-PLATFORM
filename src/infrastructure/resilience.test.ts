import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withResilience } from "@/infrastructure/resilience";
import { resetAllCircuits } from "@/infrastructure/circuit-breaker";
import { redis } from "@/infrastructure/redis";
import { ProviderError } from "@/shared/errors";

describe("withResilience", () => {
  const cacheKey = "test:resilience:key";

  beforeEach(async () => {
    resetAllCircuits();
    await redis.del(cacheKey);
  });

  afterEach(async () => {
    await redis.del(cacheKey);
  });

  it("returns a fresh cache hit without calling the provider at all", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ value: "live" });

    // Prime the cache with a first real call.
    await withResilience({
      providerName: "test-provider-cache",
      fetchFn,
      cacheKey,
      freshTtlMs: 60_000,
      staleTtlMs: 120_000,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Second call within the fresh window should hit cache, not call fetchFn again.
    const result = await withResilience({
      providerName: "test-provider-cache",
      fetchFn,
      cacheKey,
      freshTtlMs: 60_000,
      staleTtlMs: 120_000,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1); // still 1 -- proves cache was used
    expect(result.source).toBe("cache");
    expect(result.stale).toBe(false);
    expect(result.data).toEqual({ value: "live" });
  });

  it("calls the provider and caches the result on a cache miss", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ value: "fresh-data" });

    const result = await withResilience({
      providerName: "test-provider-miss",
      fetchFn,
      cacheKey,
      freshTtlMs: 60_000,
      staleTtlMs: 120_000,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("live");
    expect(result.data).toEqual({ value: "fresh-data" });
  });

  it("retries a retryable failure with backoff, then succeeds", async () => {
    const networkError = new ProviderError("test-provider-retry", "Network request failed.");
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(networkError)
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce({ value: "succeeded-on-third-try" });

    const result = await withResilience({
      providerName: "test-provider-retry",
      fetchFn,
      cacheKey,
      freshTtlMs: 60_000,
      staleTtlMs: 120_000,
      maxRetries: 3,
      baseBackoffMs: 5, // small: keep the test fast, still exercises real backoff
    });

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(result.source).toBe("live");
    expect(result.data).toEqual({ value: "succeeded-on-third-try" });
  });

  it("gives up after maxRetries on a persistently retryable failure", async () => {
    const networkError = new ProviderError("test-provider-exhaust", "Always fails.");
    const fetchFn = vi.fn().mockRejectedValue(networkError);

    await expect(
      withResilience({
        providerName: "test-provider-exhaust",
        fetchFn,
        cacheKey,
        freshTtlMs: 60_000,
        staleTtlMs: 120_000,
        maxRetries: 2,
        baseBackoffMs: 5,
      }),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(fetchFn).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it("does NOT retry a non-retryable error (e.g. a 401-equivalent)", async () => {
    const authError = new ProviderError("test-provider-401", "Bad API key.", { status: 401 });
    const fetchFn = vi.fn().mockRejectedValue(authError);

    await expect(
      withResilience({
        providerName: "test-provider-401",
        fetchFn,
        cacheKey,
        freshTtlMs: 60_000,
        staleTtlMs: 120_000,
        maxRetries: 3,
        baseBackoffMs: 5,
      }),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(fetchFn).toHaveBeenCalledTimes(1); // no retries attempted
  });

  it("falls back to a secondary provider when the primary is exhausted", async () => {
    const primaryError = new ProviderError("test-provider-primary", "Primary down.");
    const fetchFn = vi.fn().mockRejectedValue(primaryError);
    const fallbackFn = vi.fn().mockResolvedValue({ value: "from-fallback" });

    const result = await withResilience({
      providerName: "test-provider-primary",
      fetchFn,
      fallbackFn,
      fallbackProviderName: "test-provider-fallback",
      cacheKey,
      freshTtlMs: 60_000,
      staleTtlMs: 120_000,
      maxRetries: 1,
      baseBackoffMs: 5,
    });

    expect(result.source).toBe("fallback");
    expect(result.data).toEqual({ value: "from-fallback" });
  });

  it("serves stale cached data (degraded mode) when both primary and fallback fail", async () => {
    // First: a successful call to populate the cache.
    const goodFetch = vi.fn().mockResolvedValue({ value: "originally-good-data" });
    await withResilience({
      providerName: "test-provider-degraded",
      fetchFn: goodFetch,
      cacheKey,
      freshTtlMs: 1, // effectively immediately stale for the next call
      staleTtlMs: 120_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Second: both primary and fallback fail -- should fall back to the
    // now-stale cached value instead of throwing.
    const failingFetch = vi
      .fn()
      .mockRejectedValue(new ProviderError("test-provider-degraded", "Down."));
    const failingFallback = vi.fn().mockRejectedValue(new ProviderError("fallback", "Also down."));

    const result = await withResilience({
      providerName: "test-provider-degraded",
      fetchFn: failingFetch,
      fallbackFn: failingFallback,
      cacheKey,
      freshTtlMs: 1,
      staleTtlMs: 120_000,
      maxRetries: 1,
      baseBackoffMs: 5,
    });

    expect(result.source).toBe("degraded-cache");
    expect(result.stale).toBe(true);
    expect(result.data).toEqual({ value: "originally-good-data" });
  });

  it("throws a clear ProviderError when everything fails and there's no cache to degrade to", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new ProviderError("test-provider-nocache", "Down."));

    await expect(
      withResilience({
        providerName: "test-provider-nocache",
        fetchFn,
        cacheKey,
        freshTtlMs: 60_000,
        staleTtlMs: 120_000,
        maxRetries: 1,
        baseBackoffMs: 5,
      }),
    ).rejects.toThrow(/unavailable/i);
  });

  it("integrates with the circuit breaker: opens after repeated failures, then fails fast without calling the provider", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new ProviderError("test-provider-circuit", "Down."));
    const circuitOptions = { failureThreshold: 2, cooldownMs: 10_000 };

    // Two calls, each exhausting 1 retry (2 attempts each) -- 4 total
    // fetchFn calls, and 2 recordFailure()s at the orchestrator level
    // (one per withResilience call), which is what trips the breaker.
    for (let i = 0; i < 2; i++) {
      await expect(
        withResilience({
          providerName: "test-provider-circuit",
          fetchFn,
          cacheKey: `${cacheKey}-circuit`,
          freshTtlMs: 1,
          staleTtlMs: 1,
          maxRetries: 1,
          baseBackoffMs: 5,
          circuitOptions,
        }),
      ).rejects.toBeInstanceOf(ProviderError);
    }

    const callCountBeforeCircuitOpen = fetchFn.mock.calls.length;
    fetchFn.mockClear();

    // Third call: circuit should now be open -- fetchFn should not be
    // called at all.
    await expect(
      withResilience({
        providerName: "test-provider-circuit",
        fetchFn,
        cacheKey: `${cacheKey}-circuit`,
        freshTtlMs: 1,
        staleTtlMs: 1,
        maxRetries: 1,
        baseBackoffMs: 5,
        circuitOptions,
      }),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(callCountBeforeCircuitOpen).toBeGreaterThan(0);
    expect(fetchFn).not.toHaveBeenCalled();

    await redis.del(`${cacheKey}-circuit`);
  });
});
