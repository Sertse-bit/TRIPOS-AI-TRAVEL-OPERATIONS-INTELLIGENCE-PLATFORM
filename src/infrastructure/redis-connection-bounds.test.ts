import { describe, expect, it } from "vitest";
import Redis from "ioredis";

/**
 * This mirrors infrastructure/redis.ts's exact configuration against a
 * deliberately unreachable address, to prove the connectTimeout +
 * bounded retryStrategy actually cause a fast failure rather than the
 * long hang found during manual Phase 6 verification (see the comment
 * in redis.ts). Uses a separate throwaway client, not the shared
 * `redis` export, so it doesn't disrupt the connection other tests share.
 */
describe("Redis client connection bounds", () => {
  it("fails within a few seconds against an unreachable address, not hanging indefinitely", async () => {
    const unreachableClient = new Redis("redis://127.0.0.1:1", {
      maxRetriesPerRequest: 2,
      connectTimeout: 3000,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 200, 1000);
      },
      lazyConnect: true, // don't connect until the first command, keeps this test's intent explicit
    });
    unreachableClient.on("error", () => {
      // Expected -- this test is specifically about not hanging, not
      // about suppressing the (correct, expected) connection errors.
    });

    const start = Date.now();
    await expect(unreachableClient.get("anything")).rejects.toThrow();
    const elapsed = Date.now() - start;

    // Generous upper bound (10s) given retry/backoff overhead, but this
    // is what actually matters: proving it resolves in single-digit
    // seconds, not the 30+ second hang observed before this fix.
    expect(elapsed).toBeLessThan(10_000);

    unreachableClient.disconnect();
  }, 15_000);
});
