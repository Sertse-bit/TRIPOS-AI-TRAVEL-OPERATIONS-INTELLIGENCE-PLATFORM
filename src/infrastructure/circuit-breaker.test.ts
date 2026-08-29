import { beforeEach, describe, expect, it } from "vitest";
import {
  canAttempt,
  getCircuitState,
  recordFailure,
  recordSuccess,
  resetAllCircuits,
} from "@/infrastructure/circuit-breaker";

describe("circuit breaker", () => {
  beforeEach(() => {
    resetAllCircuits();
  });

  it("starts CLOSED and allows attempts", () => {
    expect(getCircuitState("test-provider")).toBe("CLOSED");
    expect(canAttempt("test-provider")).toBe(true);
  });

  it("stays CLOSED and resets the failure count on any success", () => {
    const opts = { failureThreshold: 3, cooldownMs: 1000 };
    recordFailure("test-provider", opts);
    recordFailure("test-provider", opts);
    recordSuccess("test-provider");
    recordFailure("test-provider", opts);
    // Only 1 consecutive failure since the reset — should not have opened.
    expect(getCircuitState("test-provider")).toBe("CLOSED");
  });

  it("opens after reaching the failure threshold", () => {
    const opts = { failureThreshold: 3, cooldownMs: 1000 };
    recordFailure("test-provider", opts);
    recordFailure("test-provider", opts);
    expect(getCircuitState("test-provider")).toBe("CLOSED");
    recordFailure("test-provider", opts);
    expect(getCircuitState("test-provider")).toBe("OPEN");
  });

  it("fails fast (canAttempt=false) while OPEN and within the cooldown", () => {
    const opts = { failureThreshold: 1, cooldownMs: 10_000 };
    recordFailure("test-provider", opts);
    expect(getCircuitState("test-provider")).toBe("OPEN");
    expect(canAttempt("test-provider", opts)).toBe(false);
  });

  it("moves to HALF_OPEN and allows exactly one trial after the cooldown elapses", async () => {
    const opts = { failureThreshold: 1, cooldownMs: 50 };
    recordFailure("test-provider", opts);
    expect(canAttempt("test-provider", opts)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 70));

    expect(canAttempt("test-provider", opts)).toBe(true);
    expect(getCircuitState("test-provider")).toBe("HALF_OPEN");
  });

  it("closes the circuit when the HALF_OPEN trial succeeds", async () => {
    const opts = { failureThreshold: 1, cooldownMs: 50 };
    recordFailure("test-provider", opts);
    await new Promise((resolve) => setTimeout(resolve, 70));
    canAttempt("test-provider", opts); // transitions to HALF_OPEN

    recordSuccess("test-provider");
    expect(getCircuitState("test-provider")).toBe("CLOSED");
    expect(canAttempt("test-provider", opts)).toBe(true);
  });

  it("re-opens (and restarts the cooldown) when the HALF_OPEN trial fails", async () => {
    const opts = { failureThreshold: 1, cooldownMs: 50 };
    recordFailure("test-provider", opts);
    await new Promise((resolve) => setTimeout(resolve, 70));
    canAttempt("test-provider", opts); // transitions to HALF_OPEN

    recordFailure("test-provider", opts);
    expect(getCircuitState("test-provider")).toBe("OPEN");
    // Cooldown restarted -- should not allow another attempt immediately.
    expect(canAttempt("test-provider", opts)).toBe(false);
  });

  it("tracks separate providers independently", () => {
    const opts = { failureThreshold: 1, cooldownMs: 10_000 };
    recordFailure("provider-a", opts);
    expect(getCircuitState("provider-a")).toBe("OPEN");
    expect(getCircuitState("provider-b")).toBe("CLOSED");
  });
});
