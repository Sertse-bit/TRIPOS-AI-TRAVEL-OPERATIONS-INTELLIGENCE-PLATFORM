import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/infrastructure/db";
import {
  getAllProviderHealth,
  recordProviderFailure,
  recordProviderSuccess,
} from "@/modules/observability/api-health-repository";

const TEST_PROVIDER = "test-provider-health-check";

describe("api_health repository (against real Postgres)", () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM api_health WHERE provider = $1", [TEST_PROVIDER]);
  });

  afterEach(async () => {
    await pool.query("DELETE FROM api_health WHERE provider = $1", [TEST_PROVIDER]);
  });

  it("creates a new OPERATIONAL row on first success", async () => {
    await recordProviderSuccess(TEST_PROVIDER);
    const all = await getAllProviderHealth();
    const record = all.find((r) => r.provider === TEST_PROVIDER);

    expect(record).toBeDefined();
    expect(record?.status).toBe("OPERATIONAL");
    expect(record?.consecutiveFailures).toBe(0);
    expect(record?.lastSuccessAt).not.toBeNull();
  });

  it("creates a DEGRADED row on first failure, with consecutiveFailures=1", async () => {
    await recordProviderFailure(TEST_PROVIDER);
    const all = await getAllProviderHealth();
    const record = all.find((r) => r.provider === TEST_PROVIDER);

    expect(record?.status).toBe("DEGRADED");
    expect(record?.consecutiveFailures).toBe(1);
    expect(record?.lastFailureAt).not.toBeNull();
  });

  it("escalates to DOWN at 3 consecutive failures", async () => {
    await recordProviderFailure(TEST_PROVIDER);
    await recordProviderFailure(TEST_PROVIDER);
    let all = await getAllProviderHealth();
    expect(all.find((r) => r.provider === TEST_PROVIDER)?.status).toBe("DEGRADED");

    await recordProviderFailure(TEST_PROVIDER);
    all = await getAllProviderHealth();
    const record = all.find((r) => r.provider === TEST_PROVIDER);
    expect(record?.status).toBe("DOWN");
    expect(record?.consecutiveFailures).toBe(3);
  });

  it("resets consecutiveFailures and returns to OPERATIONAL after a success following failures", async () => {
    await recordProviderFailure(TEST_PROVIDER);
    await recordProviderFailure(TEST_PROVIDER);
    await recordProviderSuccess(TEST_PROVIDER);

    const all = await getAllProviderHealth();
    const record = all.find((r) => r.provider === TEST_PROVIDER);
    expect(record?.status).toBe("OPERATIONAL");
    expect(record?.consecutiveFailures).toBe(0);
  });

  it("upserts rather than duplicating rows for the same provider", async () => {
    await recordProviderSuccess(TEST_PROVIDER);
    await recordProviderFailure(TEST_PROVIDER);
    await recordProviderSuccess(TEST_PROVIDER);

    const result = await pool.query("SELECT count(*) FROM api_health WHERE provider = $1", [
      TEST_PROVIDER,
    ]);
    expect(Number(result.rows[0].count)).toBe(1);
  });
});
