import Redis from "ioredis";
import { env } from "@/config/env";
import { RateLimitedError } from "@/shared/errors";

/**
 * Fixed-window counter, not a sliding window or token bucket: for
 * brute-force protection on login/register, a fixed window is simple,
 * cheap (one INCR + one EXPIRE per check), and sufficient — the
 * consequence of the well-known boundary-burst edge case (a client
 * getting up to 2x the limit across a window boundary) is "a few extra
 * login attempts," not a meaningful security gap. Reach for a sliding
 * window only if evidence says this matters (brief's own "optimize only
 * where evidence supports it").
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 2,
  lazyConnect: false,
});

redis.on("error", (err) => {
  console.error("Redis connection error", err);
});

interface RateLimitOptions {
  /** Identifies the limited resource, e.g. "login" or "register". */
  action: string;
  /** Identifies the caller, e.g. an IP address or email being attempted. */
  identifier: string;
  limit: number;
  windowSeconds: number;
}

/**
 * Throws RateLimitedError if the caller has exceeded `limit` attempts
 * within the current window. Fails open (allows the request) if Redis
 * itself is unreachable — an auth endpoint should degrade to "no rate
 * limiting" rather than "no one can log in" if the cache layer is down.
 * This tradeoff is deliberate and documented in docs/SECURITY.md.
 */
export async function enforceRateLimit(options: RateLimitOptions): Promise<void> {
  const key = `ratelimit:${options.action}:${options.identifier}`;

  let count: number;
  try {
    count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, options.windowSeconds);
    }
  } catch {
    // Fail open — see doc comment above.
    return;
  }

  if (count > options.limit) {
    throw new RateLimitedError(`Too many ${options.action} attempts. Try again in a bit.`);
  }
}
