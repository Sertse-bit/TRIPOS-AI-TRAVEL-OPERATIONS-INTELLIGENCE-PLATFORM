import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { enforceRateLimit, redis } from "@/infrastructure/rate-limit";
import { RateLimitedError } from "@/shared/errors";

describe("enforceRateLimit", () => {
  const testAction = "test-action";
  const testId = "test-identifier";

  beforeEach(async () => {
    await redis.del(`ratelimit:${testAction}:${testId}`);
  });

  afterAll(async () => {
    await redis.del(`ratelimit:${testAction}:${testId}`);
    redis.disconnect();
  });

  it("allows requests within the limit", async () => {
    for (let i = 0; i < 3; i++) {
      await expect(
        enforceRateLimit({ action: testAction, identifier: testId, limit: 3, windowSeconds: 60 }),
      ).resolves.toBeUndefined();
    }
  });

  it("throws RateLimitedError once the limit is exceeded", async () => {
    for (let i = 0; i < 3; i++) {
      await enforceRateLimit({
        action: testAction,
        identifier: testId,
        limit: 3,
        windowSeconds: 60,
      });
    }
    await expect(
      enforceRateLimit({ action: testAction, identifier: testId, limit: 3, windowSeconds: 60 }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("tracks different identifiers independently", async () => {
    await redis.del(`ratelimit:${testAction}:other-identifier`);
    for (let i = 0; i < 3; i++) {
      await enforceRateLimit({
        action: testAction,
        identifier: testId,
        limit: 3,
        windowSeconds: 60,
      });
    }
    // A different identifier should not be affected by testId's count
    await expect(
      enforceRateLimit({
        action: testAction,
        identifier: "other-identifier",
        limit: 3,
        windowSeconds: 60,
      }),
    ).resolves.toBeUndefined();
    await redis.del(`ratelimit:${testAction}:other-identifier`);
  });

  it("resets after the window expires", async () => {
    await enforceRateLimit({ action: testAction, identifier: testId, limit: 1, windowSeconds: 1 });
    await expect(
      enforceRateLimit({ action: testAction, identifier: testId, limit: 1, windowSeconds: 1 }),
    ).rejects.toBeInstanceOf(RateLimitedError);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    await expect(
      enforceRateLimit({ action: testAction, identifier: testId, limit: 1, windowSeconds: 1 }),
    ).resolves.toBeUndefined();
  });
});
