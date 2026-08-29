import Redis from "ioredis";
import { env } from "@/config/env";

/**
 * connectTimeout and a capped retryStrategy are deliberate, not default
 * values: found via a real hang during manual Phase 6 verification that
 * ioredis's default reconnect behavior can take a long time to give up
 * when Redis is genuinely unreachable (as opposed to reachable-but-erroring).
 * Every caller that treats Redis as an optional cache layer (see
 * infrastructure/resilience.ts's "cache is an optimization, never a hard
 * dependency" try/catch) depends on failures actually being fast, or that
 * design intent doesn't hold in practice.
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 2,
  connectTimeout: 3000,
  retryStrategy(times) {
    if (times > 3) return null; // stop retrying, let it fail
    return Math.min(times * 200, 1000);
  },
  lazyConnect: false,
});

redis.on("error", (err) => {
  console.error("Redis connection error", err);
});
