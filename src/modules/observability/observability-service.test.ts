import { afterEach, describe, expect, it } from "vitest";
import { pool } from "@/infrastructure/db";
import { providerAvailability } from "@/config/env";
import { recordFailure, resetAllCircuits } from "@/infrastructure/circuit-breaker";
import {
  recordProviderFailure,
  recordProviderSuccess,
} from "@/modules/observability/api-health-repository";
import { getSystemObservability } from "@/modules/observability/observability-service";

/**
 * A name no real integration uses, so these tests can write health rows
 * and trip the circuit breaker freely without colliding with another
 * suite's provider rows in the shared test database.
 */
const TEST_PROVIDER = "observability-test-provider";

afterEach(async () => {
  resetAllCircuits();
  await pool.query(`DELETE FROM api_health WHERE provider = $1`, [TEST_PROVIDER]);
});

describe("getSystemObservability: infrastructure checks are real", () => {
  it("performs genuine database and Redis round trips and reports measured latency", async () => {
    const report = await getSystemObservability();

    expect(report.infrastructure.map((check) => check.name).sort()).toEqual(["database", "redis"]);

    for (const check of report.infrastructure) {
      expect(check.reachable).toBe(true);
      expect(check.latencyMs).toBeTypeOf("number");
      expect(check.latencyMs).toBeGreaterThanOrEqual(0);
      expect(check.error).toBeNull();
    }
  });
});

describe("getSystemObservability: the provider universe", () => {
  it("includes every provider this build can configure, plus providers only known from health records", async () => {
    await recordProviderSuccess(TEST_PROVIDER);

    const report = await getSystemObservability();
    const names = report.providers.map((entry) => entry.provider);

    for (const configured of Object.keys(providerAvailability)) {
      expect(names).toContain(configured);
    }
    expect(names).toContain(TEST_PROVIDER);

    // Sorted, so the panel's ordering is stable between requests.
    expect(names).toEqual([...names].sort());
  });

  it("reports a provider with no recorded attempt as never exercised — not as healthy", async () => {
    // One in-process circuit failure names the provider without writing
    // any api_health row: the entry must show circuit activity and a null
    // health status, never a synthetic OPERATIONAL.
    recordFailure(TEST_PROVIDER);

    const report = await getSystemObservability();
    const tracked = report.providers.find((entry) => entry.provider === TEST_PROVIDER);

    expect(tracked).toBeDefined();
    expect(tracked?.health).toBeNull();
    expect(tracked?.circuit).toEqual({
      state: "CLOSED",
      consecutiveFailures: 1,
      openedAt: null,
    });

    // The summary agrees with the rows it summarizes.
    expect(report.summary.neverExercised).toBe(
      report.providers.filter((entry) => entry.health === null).length,
    );
  });
});

describe("getSystemObservability: recorded health is reported verbatim", () => {
  it("shows a real failure streak as DEGRADED then DOWN, and a real success back to OPERATIONAL", async () => {
    await recordProviderFailure(TEST_PROVIDER);
    await recordProviderFailure(TEST_PROVIDER);

    const degraded = await getSystemObservability();
    const degradedEntry = degraded.providers.find((entry) => entry.provider === TEST_PROVIDER);
    expect(degradedEntry?.health?.status).toBe("DEGRADED");
    expect(degradedEntry?.health?.consecutiveFailures).toBe(2);
    expect(degradedEntry?.health?.lastFailureAt).not.toBeNull();
    expect(degradedEntry?.health?.lastSuccessAt).toBeNull();

    await recordProviderFailure(TEST_PROVIDER);
    const down = await getSystemObservability();
    expect(down.providers.find((entry) => entry.provider === TEST_PROVIDER)?.health?.status).toBe(
      "DOWN",
    );

    await recordProviderSuccess(TEST_PROVIDER);
    const recovered = await getSystemObservability();
    const recoveredEntry = recovered.providers.find((entry) => entry.provider === TEST_PROVIDER);
    expect(recoveredEntry?.health?.status).toBe("OPERATIONAL");
    expect(recoveredEntry?.health?.consecutiveFailures).toBe(0);
    expect(recoveredEntry?.health?.lastSuccessAt).not.toBeNull();
  });

  it("surfaces an open in-process circuit without pretending a health row exists", async () => {
    // The breaker's own threshold is 5 consecutive failures by default.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      recordFailure(TEST_PROVIDER);
    }

    const report = await getSystemObservability();
    const entry = report.providers.find((candidate) => candidate.provider === TEST_PROVIDER);

    expect(entry?.circuit?.state).toBe("OPEN");
    expect(entry?.circuit?.openedAt).not.toBeNull();
    // No provider call was recorded through api_health, and the report
    // says so rather than inventing a health status from circuit state.
    expect(entry?.health).toBeNull();
  });
});
