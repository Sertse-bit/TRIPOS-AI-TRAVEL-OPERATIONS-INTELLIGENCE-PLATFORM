import { pool } from "@/infrastructure/db";
import { redis } from "@/infrastructure/redis";
import { providerAvailability } from "@/config/env";
import { getAllCircuitStates, type CircuitState } from "@/infrastructure/circuit-breaker";
import {
  getAllProviderHealth,
  type ApiHealthStatus,
} from "@/modules/observability/api-health-repository";

/**
 * Phase 23 — the System Observability panel's data model.
 *
 * Every field here is either a real measurement taken at request time or
 * a row the resilience layer wrote after a real provider attempt. There
 * is no placeholder, no "assume healthy", and no smoothing: a provider
 * that has never been called reports `health: null` (rendered as "never
 * exercised"), never as OPERATIONAL, because those are different facts
 * and the brief forbids inventing the first as the second.
 *
 * What this module deliberately does NOT do: collect process CPU/memory
 * metrics, read log files, or scrape anything. Those would need a
 * metrics pipeline this build doesn't have, and a panel that showed
 * numbers nobody actually measured would be exactly the failure mode the
 * project exists to avoid.
 */

export type InfrastructureName = "database" | "redis";

export interface InfrastructureCheck {
  name: InfrastructureName;
  reachable: boolean;
  /** Measured round-trip of the real check; null when it failed. */
  latencyMs: number | null;
  /**
   * The provider/client's own error message, truncated. Ops-relevant
   * (host/port/timeout) and shown only to authenticated users; these
   * client libraries never include credentials in their error text.
   */
  error: string | null;
}

export interface ProviderObservability {
  provider: string;
  /** Real env-var presence, same source as the settings page. */
  configured: boolean;
  /** Latest recorded attempt, or null when no real call has been made yet. */
  health: {
    status: ApiHealthStatus;
    lastCheckedAt: string;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    consecutiveFailures: number;
  } | null;
  /** In-process circuit state, or null when this process never attempted the provider. */
  circuit: {
    state: CircuitState;
    consecutiveFailures: number;
    openedAt: string | null;
  } | null;
}

export interface ObservabilityReport {
  checkedAt: string;
  infrastructure: InfrastructureCheck[];
  providers: ProviderObservability[];
  summary: {
    providers: number;
    configured: number;
    operational: number;
    degraded: number;
    down: number;
    /** Providers with no recorded attempt at all — distinct from "healthy". */
    neverExercised: number;
  };
}

const MAX_ERROR_LENGTH = 300;

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error.";
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

async function checkDatabase(): Promise<InfrastructureCheck> {
  const startedAt = Date.now();
  try {
    await pool.query("SELECT 1");
    return {
      name: "database",
      reachable: true,
      latencyMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    return { name: "database", reachable: false, latencyMs: null, error: describeError(error) };
  }
}

async function checkRedis(): Promise<InfrastructureCheck> {
  const startedAt = Date.now();
  try {
    await redis.ping();
    return { name: "redis", reachable: true, latencyMs: Date.now() - startedAt, error: null };
  } catch (error) {
    return { name: "redis", reachable: false, latencyMs: null, error: describeError(error) };
  }
}

/**
 * The provider list is the union of three real sources: every provider
 * this build knows how to configure, every provider the resilience layer
 * has recorded a health row for, and every provider with in-process
 * circuit state. The last two can name a provider the first doesn't
 * (e.g. a fallback vendor name), and dropping those would hide exactly
 * the thing the panel exists to show.
 */
function providerUniverse(healthProviders: string[], circuitProviders: string[]): string[] {
  return [
    ...new Set([...Object.keys(providerAvailability), ...healthProviders, ...circuitProviders]),
  ].sort();
}

export async function getSystemObservability(): Promise<ObservabilityReport> {
  const [infrastructure, healthRows, circuits] = await Promise.all([
    Promise.all([checkDatabase(), checkRedis()]),
    getAllProviderHealth(),
    Promise.resolve(getAllCircuitStates()),
  ]);

  const healthByProvider = new Map(healthRows.map((row) => [row.provider, row]));
  const circuitByProvider = new Map(circuits.map((snapshot) => [snapshot.provider, snapshot]));

  const providers = providerUniverse(
    healthRows.map((row) => row.provider),
    circuits.map((snapshot) => snapshot.provider),
  ).map((provider): ProviderObservability => {
    const health = healthByProvider.get(provider);
    const circuit = circuitByProvider.get(provider);

    return {
      provider,
      configured: Boolean((providerAvailability as Record<string, boolean | undefined>)[provider]),
      health: health
        ? {
            status: health.status,
            lastCheckedAt: health.lastCheckedAt.toISOString(),
            lastSuccessAt: health.lastSuccessAt?.toISOString() ?? null,
            lastFailureAt: health.lastFailureAt?.toISOString() ?? null,
            consecutiveFailures: health.consecutiveFailures,
          }
        : null,
      circuit: circuit
        ? {
            state: circuit.state,
            consecutiveFailures: circuit.consecutiveFailures,
            openedAt: circuit.openedAt === null ? null : new Date(circuit.openedAt).toISOString(),
          }
        : null,
    };
  });

  const statuses = providers.map((entry) => entry.health?.status ?? null);

  return {
    checkedAt: new Date().toISOString(),
    infrastructure,
    providers,
    summary: {
      providers: providers.length,
      configured: providers.filter((entry) => entry.configured).length,
      operational: statuses.filter((status) => status === "OPERATIONAL").length,
      degraded: statuses.filter((status) => status === "DEGRADED").length,
      down: statuses.filter((status) => status === "DOWN").length,
      neverExercised: statuses.filter((status) => status === null).length,
    },
  };
}
