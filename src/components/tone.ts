/**
 * Pure display helpers, deliberately in their own module with no
 * "use client" directive.
 *
 * These live apart from `components/ui.tsx` because that file IS a client
 * module: every one of its exports becomes a client reference when
 * imported from a server component, and calling one of those
 * references on the server throws
 * "Attempted to call X() from the server but X is on the client".
 * Server components can RENDER a client component (StatusBadge) but
 * cannot CALL a function that came from one — so the functions live
 * here, and the components stay over there.
 */

export type Tone = "ok" | "warn" | "alert" | "neutral";

export function tripStatusTone(status: string): Tone {
  switch (status) {
    case "ACTIVE":
    case "COMPLETED":
      return "ok";
    case "CANCELLED":
      return "alert";
    case "UPCOMING":
      return "warn";
    default:
      return "neutral";
  }
}

export function flightStatusTone(status: string): Tone {
  switch (status) {
    case "LANDED":
    case "COMPLETED":
      return "ok";
    case "DELAYED":
      return "warn";
    case "CANCELLED":
      return "alert";
    default:
      return "neutral";
  }
}

/**
 * READY is the only genuinely "good" document state; UPLOADED/PROCESSING
 * are in-flight (neutral), and FAILED is the one that needs a human.
 */
export function documentStatusTone(status: string): Tone {
  switch (status) {
    case "READY":
      return "ok";
    case "FAILED":
      return "alert";
    case "PROCESSING":
      return "warn";
    default:
      return "neutral";
  }
}

/** Phase 16 risk severity — the same four bands the scoring model emits. */
export function riskSeverityTone(severity: string): Tone {
  switch (severity) {
    case "LOW":
      return "ok";
    case "MEDIUM":
      return "warn";
    case "HIGH":
    case "CRITICAL":
      return "alert";
    default:
      return "neutral";
  }
}

/**
 * Provider health (Phase 23), as recorded by the resilience layer after
 * real provider attempts. Thresholds are the repository's own: 1-2
 * consecutive failures is DEGRADED, 3+ is DOWN.
 */
export function apiHealthTone(status: string): Tone {
  switch (status) {
    case "OPERATIONAL":
      return "ok";
    case "DEGRADED":
      return "warn";
    case "DOWN":
      return "alert";
    default:
      return "neutral";
  }
}

/**
 * Circuit breaker state (Phase 23). CLOSED is the healthy state here --
 * the naming is inverted from the risk tones on purpose: a closed
 * circuit is a working one.
 */
export function circuitStateTone(state: string): Tone {
  switch (state) {
    case "CLOSED":
      return "ok";
    case "HALF_OPEN":
      return "warn";
    case "OPEN":
      return "alert";
    default:
      return "neutral";
  }
}

/**
 * Recommendation lifecycle (Phase 17), which is a different axis from
 * risk severity: PENDING means nobody has looked at it yet, so it reads
 * as needing attention rather than being scored.
 */
export function recommendationStatusTone(status: string): Tone {
  switch (status) {
    case "ACKNOWLEDGED":
      return "ok";
    case "DISMISSED":
      return "neutral";
    default:
      return "warn";
  }
}
