import type { AuditLogRecord } from "@/modules/audit/audit-repository";

/**
 * Pure helpers + the shared audit entry row for Phase 24's two audit
 * surfaces (the /trips/audit stream and the trip page's recent-activity
 * card). Lives apart from components/ui.tsx (a client module) so server
 * components can call the helpers directly — the same split Phase 23
 * documented in components/tone.ts.
 *
 * Nothing here derives a value the log didn't record: the actor label
 * comes from the stored ActorType, the action label from the stored
 * action string, and the timestamp from the stored row. Unknown actions
 * render their raw string rather than a guess.
 */

export const AUDIT_PAGE_SIZE = 50;

/** Reads the trip title stamped into metadata by the route helpers. */
export function auditTripTitle(entry: AuditLogRecord): string | undefined {
  const value = entry.metadata?.tripTitle;
  return typeof value === "string" ? value : undefined;
}

/** The palette is navy/sand/ok/warn/alert only — no new hues for actors. */
export function auditActorPillClasses(actorType: AuditLogRecord["actorType"]): string {
  switch (actorType) {
    case "USER":
      return "bg-navy-100 text-navy-700 dark:text-navy-500";
    case "AI_AGENT":
      return "bg-warn-100 text-warn-700 dark:text-warn-500";
    case "SYSTEM":
      return "bg-sand-100 text-sand-600 dark:text-sand-500";
  }
}

/**
 * The actor side of the pill. A USER row names its own id, which the
 * viewer is not shown raw — "You" is only accurate on the user's own
 * stream, and this row is always rendered inside that stream or inside a
 * trip they own, so it is accurate here.
 */
export function auditActorLabel(entry: AuditLogRecord): string {
  switch (entry.actorType) {
    case "USER":
      return "You";
    case "AI_AGENT":
      // The stored actor id IS the agent name (see audit-service).
      return entry.actorId ?? "Agent";
    case "SYSTEM":
      return "System";
  }
}

/**
 * Human labels for the actions this phase actually writes. Anything not
 * in this map falls through to the raw action string — an unmapped
 * action shows up instead of being hidden or politely renamed.
 */
const ACTION_LABELS: Record<string, string> = {
  "trip.create": "Created trip",
  "trip.update": "Updated trip details",
  "trip.status_change": "Changed trip status",
  "destination.add": "Added destination",
  "flight.add": "Added flight",
  "traveler.add": "Added traveler",
  "budget.set": "Set budget cap",
  "budget.clear": "Cleared budget cap",
  "itinerary.item_add": "Added itinerary item",
  "itinerary.item_update": "Updated itinerary item",
  "itinerary.item_delete": "Removed itinerary item",
  "document.upload": "Uploaded document",
  "document.reindex": "Re-indexed document",
  "notification.read": "Read an alert",
  "auth.register": "Created account",
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "watch.upsert": "Changed Trip Watch settings",
  "watch.sweep": "Watch sweep ran",
  "flight.status_update": "Checked flight status",
  "weather.snapshot_recorded": "Recorded weather snapshot",
  "risk.assessed": "Assessed risk",
  "recommendation.created": "Wrote a recommendation",
  "itinerary.plan_generated": "Generated an itinerary plan",
};

export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/**
 * UTC-stable rendering: the same string on the server and in any client
 * that repeats it, so a row cannot read as two different times.
 */
export function formatAuditTime(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

/**
 * One audit row, shared by both surfaces. `tripTitle` is passed in only
 * by the user-wide stream, where "which trip" is not implied by the
 * page; the trip page already says it once at the top.
 */
export function AuditEntryRow({ entry, tripTitle }: { entry: AuditLogRecord; tripTitle?: string }) {
  const outcome = typeof entry.metadata?.outcome === "string" ? entry.metadata.outcome : null;
  const changed = entry.metadata?.changed === true;
  const status = typeof entry.metadata?.status === "string" ? entry.metadata.status : null;

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${auditActorPillClasses(entry.actorType)}`}
        >
          {auditActorLabel(entry)}
        </span>
        <span className="text-sm font-medium text-navy-950 dark:text-navy-100">
          {auditActionLabel(entry.action)}
        </span>
        {tripTitle ? (
          <span className="min-w-0 truncate text-xs text-sand-500">· {tripTitle}</span>
        ) : null}
        <time className="ml-auto flex-none text-xs text-sand-400">
          {formatAuditTime(entry.createdAt)}
        </time>
      </div>
      <p className="mt-1 text-xs text-sand-500">
        <span className="font-mono">{entry.action}</span> on {entry.entityType}
        {changed ? " · changed" : ""}
        {status ? ` · ${status}` : ""}
        {outcome ? ` · ${outcome}` : ""}
        {entry.requestId ? ` · request ${entry.requestId}` : " · no request id"}
      </p>
    </li>
  );
}
