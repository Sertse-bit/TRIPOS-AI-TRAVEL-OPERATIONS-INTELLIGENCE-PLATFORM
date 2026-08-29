import { redis } from "@/infrastructure/redis";
import {
  canAttempt,
  recordFailure,
  recordSuccess,
  type CircuitBreakerOptions,
} from "@/infrastructure/circuit-breaker";
import {
  recordProviderFailure,
  recordProviderSuccess,
} from "@/modules/observability/api-health-repository";
import { logger } from "@/infrastructure/logger";
import { ProviderError, isAppError } from "@/shared/errors";

/**
 * Implements the flow from docs/ARCHITECTURE.md's resilience design:
 *
 *   REQUEST → CACHE CHECK → hit? return : PROVIDER → success? cache+return
 *     : RETRY → still fail? FALLBACK / DEGRADED MODE
 *
 * Every result says how it was obtained (source/stale) — this matters
 * beyond logging: Phase 17 (Explainable AI) will want a recommendation
 * built on stale weather data to carry lower confidence than one built
 * on a live reading, and this is where that provenance originates.
 */

export interface ResilientResult<T> {
  data: T;
  source: "cache" | "live" | "fallback" | "degraded-cache";
  stale: boolean;
}

export interface ResilienceOptions<T> {
  providerName: string;
  fetchFn: () => Promise<T>;
  fallbackFn?: () => Promise<T>;
  fallbackProviderName?: string;
  cacheKey: string;
  /** How long a cached value is served without even attempting a live call. */
  freshTtlMs: number;
  /** How much longer (beyond freshTtlMs) a stale value stays eligible for degraded-mode use. */
  staleTtlMs: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  circuitOptions?: CircuitBreakerOptions;
}

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 5xx, 429, and network/timeout failures are worth retrying; 4xx (bad key, bad request) are not. */
function isRetryable(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  const status = (error.details as { status?: number } | undefined)?.status;
  if (status === undefined) return true; // network/timeout failure — no status at all
  return status === 429 || status >= 500;
}

async function getCacheEntry<T>(cacheKey: string): Promise<CacheEntry<T> | null> {
  try {
    const raw = await redis.get(cacheKey);
    return raw ? (JSON.parse(raw) as CacheEntry<T>) : null;
  } catch {
    return null; // cache is an optimization, never a hard dependency
  }
}

async function setCacheEntry<T>(cacheKey: string, data: T, staleTtlMs: number): Promise<void> {
  try {
    const entry: CacheEntry<T> = { data, cachedAt: Date.now() };
    await redis.set(cacheKey, JSON.stringify(entry), "PX", staleTtlMs);
  } catch {
    // Caching is an optimization; a write failure shouldn't fail the request.
  }
}

async function attemptWithRetry<T>(
  providerName: string,
  fetchFn: () => Promise<T>,
  maxRetries: number,
  baseBackoffMs: number,
  circuitOptions?: CircuitBreakerOptions,
): Promise<T> {
  if (!canAttempt(providerName, circuitOptions)) {
    throw new ProviderError(
      providerName,
      `${providerName} circuit is open; not attempting a call.`,
    );
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fetchFn();
      recordSuccess(providerName);
      void recordProviderSuccess(providerName).catch(() => {
        // Observability write failure should never affect the actual
        // response — the primary call already succeeded.
      });
      return result;
    } catch (error) {
      lastError = error;
      const retryable = isRetryable(error);

      logger.warn(
        { providerName, attempt, maxRetries, retryable, err: error },
        "Provider call failed",
      );

      if (!retryable || attempt === maxRetries) break;

      // Exponential backoff with jitter, to avoid many concurrent
      // callers retrying in lockstep against an already-struggling
      // provider (a classic thundering-herd risk).
      const backoff = baseBackoffMs * 2 ** attempt;
      const jitter = Math.random() * backoff * 0.2;
      await sleep(backoff + jitter);
    }
  }

  recordFailure(providerName, circuitOptions);
  void recordProviderFailure(providerName).catch(() => {});
  throw lastError;
}

export async function withResilience<T>(
  options: ResilienceOptions<T>,
): Promise<ResilientResult<T>> {
  const maxRetries = options.maxRetries ?? 2;
  const baseBackoffMs = options.baseBackoffMs ?? 200;

  const cached = await getCacheEntry<T>(options.cacheKey);
  const now = Date.now();

  if (cached && now - cached.cachedAt < options.freshTtlMs) {
    return { data: cached.data, source: "cache", stale: false };
  }

  try {
    const result = await attemptWithRetry(
      options.providerName,
      options.fetchFn,
      maxRetries,
      baseBackoffMs,
      options.circuitOptions,
    );
    await setCacheEntry(options.cacheKey, result, options.staleTtlMs);
    return { data: result, source: "live", stale: false };
  } catch (primaryError) {
    if (options.fallbackFn) {
      try {
        const fallbackResult = await attemptWithRetry(
          options.fallbackProviderName ?? `${options.providerName}-fallback`,
          options.fallbackFn,
          maxRetries,
          baseBackoffMs,
          options.circuitOptions,
        );
        await setCacheEntry(options.cacheKey, fallbackResult, options.staleTtlMs);
        logger.info(
          { providerName: options.providerName },
          "Primary provider failed; fallback succeeded",
        );
        return { data: fallbackResult, source: "fallback", stale: false };
      } catch (fallbackError) {
        logger.warn(
          { providerName: options.providerName, err: fallbackError },
          "Fallback provider also failed",
        );
        // fall through to degraded mode below
      }
    }

    if (cached) {
      logger.warn(
        { providerName: options.providerName, cachedAt: cached.cachedAt },
        "All live attempts failed; serving stale cached data (degraded mode)",
      );
      return { data: cached.data, source: "degraded-cache", stale: true };
    }

    const message = isAppError(primaryError) ? primaryError.message : "Provider unavailable.";
    throw new ProviderError(
      options.providerName,
      `${options.providerName} and all fallbacks are unavailable, and no cached data exists to degrade to: ${message}`,
    );
  }
}
