/**
 * Classic three-state circuit breaker: CLOSED (normal) → OPEN (failing
 * fast after too many consecutive failures) → HALF_OPEN (one trial
 * request after a cooldown) → back to CLOSED or OPEN depending on that
 * trial's outcome.
 *
 * In-memory, one instance per provider, per process — deliberately not
 * Redis-backed. This app runs as a single Next.js instance; sharing
 * circuit state across multiple instances would need Redis, but building
 * that now would be exactly the "unnecessary distributed complexity" the
 * brief warns against elsewhere (Phase 18) with no current evidence it's
 * needed. The pattern here generalizes cleanly to a Redis-backed version
 * later if a real multi-instance deployment ever requires it.
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold: number;
  /** How long the circuit stays open before allowing a half-open trial. */
  cooldownMs: number;
}

interface CircuitRecord {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number | null;
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  cooldownMs: 30_000,
};

const circuits = new Map<string, CircuitRecord>();

function getRecord(providerName: string): CircuitRecord {
  let record = circuits.get(providerName);
  if (!record) {
    record = { state: "CLOSED", consecutiveFailures: 0, openedAt: null };
    circuits.set(providerName, record);
  }
  return record;
}

/**
 * Whether a call should even be attempted right now. Transitions OPEN →
 * HALF_OPEN automatically once the cooldown has elapsed — the caller
 * doesn't need to poll or schedule anything separately.
 */
export function canAttempt(
  providerName: string,
  options: CircuitBreakerOptions = DEFAULT_OPTIONS,
): boolean {
  const record = getRecord(providerName);

  if (record.state === "CLOSED") return true;

  if (record.state === "OPEN") {
    const cooldownElapsed =
      record.openedAt !== null && Date.now() - record.openedAt >= options.cooldownMs;
    if (cooldownElapsed) {
      record.state = "HALF_OPEN";
      return true;
    }
    return false;
  }

  // HALF_OPEN: exactly one trial is allowed through. Once the trial's
  // result comes back (recordSuccess/recordFailure), the state moves on
  // from here — so "true" here reflects that a trial is currently
  // in-flight-eligible, not that unlimited calls are allowed.
  return true;
}

export function recordSuccess(providerName: string): void {
  const record = getRecord(providerName);
  record.state = "CLOSED";
  record.consecutiveFailures = 0;
  record.openedAt = null;
}

export function recordFailure(
  providerName: string,
  options: CircuitBreakerOptions = DEFAULT_OPTIONS,
): void {
  const record = getRecord(providerName);

  if (record.state === "HALF_OPEN") {
    // The trial failed — back to fully OPEN, restart the cooldown.
    record.state = "OPEN";
    record.openedAt = Date.now();
    return;
  }

  record.consecutiveFailures += 1;
  if (record.consecutiveFailures >= options.failureThreshold) {
    record.state = "OPEN";
    record.openedAt = Date.now();
  }
}

export function getCircuitState(providerName: string): CircuitState {
  return getRecord(providerName).state;
}

/** Test-only: clears all circuit state between test cases. */
export function resetAllCircuits(): void {
  circuits.clear();
}
