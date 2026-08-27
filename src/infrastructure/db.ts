import { Pool } from "pg";
import { env } from "@/config/env";

/**
 * Shared connection pool.
 *
 * INTERIM MEASURE: `prisma/schema.prisma` (Phase 3) is the source of
 * truth for the schema, but Prisma Client can't be generated in the
 * sandbox this was built in (see docs/DATABASE.md — `prisma generate`
 * needs a binary from a domain outside this sandbox's network allowlist).
 * Runtime data access therefore uses `pg` directly for now, against the
 * exact same tables/columns Phase 3 verified with real DDL.
 *
 * This is intentionally isolated behind repository modules
 * (e.g. `modules/auth/user-repository.ts`) rather than scattered through
 * business logic, so swapping to Prisma Client later — once `prisma
 * generate` can run in a normal environment — is a contained change to
 * those repository files, not a rewrite of anything that calls them.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});

pool.on("error", (err) => {
  // A truly unexpected pool-level error (e.g. connection reset). Don't
  // let it crash the process silently — surface it. Route handlers
  // already handle per-query errors via withApiHandler.
  console.error("Unexpected database pool error", err);
});
