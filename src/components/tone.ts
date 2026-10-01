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
