import { pool } from "@/infrastructure/db";

export type ApiHealthStatus = "OPERATIONAL" | "DEGRADED" | "DOWN";

export interface ApiHealthRecord {
  provider: string;
  status: ApiHealthStatus;
  lastCheckedAt: Date;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  consecutiveFailures: number;
}

/**
 * Called from the resilience layer on every real provider attempt — see
 * infrastructure/resilience.ts. This is what lets Phase 23's
 * observability panel show genuine per-provider status instead of the
 * "do not invent metrics" violation a hardcoded "all operational" would
 * be.
 */
export async function recordProviderSuccess(provider: string): Promise<void> {
  await pool.query(
    `INSERT INTO api_health (provider, status, last_checked_at, last_success_at, consecutive_failures)
     VALUES ($1, 'OPERATIONAL'::"ApiHealthStatus", now(), now(), 0)
     ON CONFLICT (provider) DO UPDATE SET
       status = 'OPERATIONAL'::"ApiHealthStatus",
       last_checked_at = now(),
       last_success_at = now(),
       consecutive_failures = 0,
       updated_at = now()`,
    [provider],
  );
}

/**
 * Status thresholds are intentionally simple and documented here, not
 * buried: 1–2 consecutive failures is DEGRADED (could be a blip), 3+ is
 * DOWN. This is independent of the circuit breaker's own failure
 * threshold (default 5) — the circuit breaker decides when to stop
 * *attempting* calls; this decides what to *report*, and reporting
 * degradation earlier than the circuit trips is deliberate so the
 * observability panel reflects trouble before the circuit actually opens.
 */
export async function recordProviderFailure(provider: string): Promise<void> {
  const result = await pool.query(
    `INSERT INTO api_health (provider, status, last_checked_at, last_failure_at, consecutive_failures)
     VALUES ($1, 'DEGRADED'::"ApiHealthStatus", now(), now(), 1)
     ON CONFLICT (provider) DO UPDATE SET
       last_checked_at = now(),
       last_failure_at = now(),
       consecutive_failures = api_health.consecutive_failures + 1,
       status = CASE
         WHEN api_health.consecutive_failures + 1 >= 3 THEN 'DOWN'::"ApiHealthStatus"
         ELSE 'DEGRADED'::"ApiHealthStatus"
       END,
       updated_at = now()
     RETURNING consecutive_failures, status`,
    [provider],
  );
  void result;
}

export async function getAllProviderHealth(): Promise<ApiHealthRecord[]> {
  const result = await pool.query(
    `SELECT provider, status, last_checked_at, last_success_at, last_failure_at, consecutive_failures
     FROM api_health ORDER BY provider`,
  );
  return result.rows.map((row) => ({
    provider: row.provider,
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    consecutiveFailures: row.consecutive_failures,
  }));
}
