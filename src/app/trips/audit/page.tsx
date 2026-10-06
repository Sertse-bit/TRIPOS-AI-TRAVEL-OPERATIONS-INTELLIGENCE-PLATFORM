import Link from "next/link";
import { requireSession } from "@/app/require-auth";
import { getUserAuditTrail } from "@/modules/audit/audit-service";
import { Card, EmptyState, SectionHeading } from "@/components/ui";
import { AuditEntryRow, auditTripTitle, AUDIT_PAGE_SIZE } from "../audit-view";

/**
 * Phase 24 — the traveler's audit stream: every audited action across
 * all of their trips, newest first. A server component reading the same
 * service the API exposes, ownership-scoped by construction (the trip
 * id set comes from the caller's own trips — see audit-service).
 */

export const metadata = { title: "Audit trail — TripOS" };

export default async function AuditPage() {
  const user = await requireSession("/trips/audit");
  const page = await getUserAuditTrail(user.id, { limit: AUDIT_PAGE_SIZE });

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-navy-950 dark:text-navy-100">
            Audit trail
          </h1>
          <p className="mt-1 text-sm text-sand-600">
            Who did what across your trips — your actions, agent deliveries, and watch-sweep runs.
            {page.total > page.entries.length
              ? ` Showing the ${page.entries.length} most recent of ${page.total}.`
              : ""}
          </p>
        </div>
        <span className="rounded-full bg-sand-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-sand-600">
          {page.total} {page.total === 1 ? "entry" : "entries"}
        </span>
      </div>

      {page.entries.length === 0 ? (
        <Card className="mt-6">
          <EmptyState>
            <span className="block">
              Nothing recorded yet. Actions like creating a trip, adding a flight, running an agent,
              or a watch sweep appear here once they happen — the log records what actually occurred
              and never back-fills history.
            </span>
          </EmptyState>
        </Card>
      ) : (
        <Card className="mt-6">
          <SectionHeading>Recent activity</SectionHeading>
          <ul className="mt-3 divide-y divide-sand-200 dark:divide-sand-200">
            {page.entries.map((entry) => (
              <AuditEntryRow key={entry.id} entry={entry} tripTitle={auditTripTitle(entry)} />
            ))}
          </ul>
        </Card>
      )}

      <p className="mt-4 text-xs text-sand-500">
        Every row carries the request ID that produced it, tying it to the same run visible in the
        API envelope and server logs.{" "}
        <Link href="/trips/observability" className="underline hover:text-sand-700">
          System health
        </Link>{" "}
        covers the provider/infrastructure side.
      </p>
    </div>
  );
}
