import Link from "next/link";
import { requireSession } from "@/app/require-auth";
import { countDueWatches, listTripWatches } from "@/modules/monitor/watch-service";
import { Card, EmptyState, SectionHeading, StatusBadge } from "@/components/ui";
import { tripStatusTone } from "@/components/tone";
import { RunDueWatchesButton } from "@/app/trips/[id]/trip-actions";

function fmtDateTime(d: Date | string): string {
  return new Date(d).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Trip Watch console (Phase 19).
 *
 * Shows every watch the user owns with the scheduler's own state —
 * last run, next run, last failure — rather than a derived "healthy"
 * label. A watch whose last pass failed says so here; it is never
 * rendered as simply "checked".
 */
export default async function WatchesPage() {
  const user = await requireSession("/trips/watches");
  const [watches, due] = await Promise.all([
    listTripWatches(user.id),
    countDueWatches({ ownerId: user.id }),
  ]);

  const enabled = watches.filter((watch) => watch.enabled);

  return (
    <div>
      <Link href="/trips" className="text-sm text-sand-600 underline-offset-2 hover:underline">
        ← All trips
      </Link>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-navy-950 dark:text-sand-800">
            Trip Watch
          </h1>
          <p className="mt-1 text-sm text-sand-600">
            Automatic monitoring for the trips you choose. Each pass makes real provider calls, so
            the cadence you set is the real one — nothing here is simulated.
          </p>
        </div>
        <p className="text-sm text-sand-600">
          {enabled.length} watched · {due} due now
        </p>
      </div>

      <Card className="mt-4">
        <SectionHeading>Run due checks</SectionHeading>
        <p className="mt-1.5 text-sm text-sand-600">
          Runs one monitoring pass for every watch that is due, and reports each outcome separately.
          A sweep is idempotent: a watch that already ran is scheduled forward and will not run
          twice, so pressing this repeatedly is safe.
        </p>
        <div className="mt-3">
          <RunDueWatchesButton />
        </div>
      </Card>

      <Card className="mt-6">
        <SectionHeading>Your watches</SectionHeading>
        {watches.length === 0 ? (
          <EmptyState>
            <span className="mt-2 block">
              No trips are watched yet. Open a trip and use &ldquo;Watch this trip&rdquo; to start.
            </span>
          </EmptyState>
        ) : (
          <ul className="mt-3 divide-y divide-sand-200 dark:divide-sand-200">
            {watches.map((watch) => (
              <li key={watch.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <Link
                      href={`/trips/${watch.tripId}`}
                      className="font-medium text-navy-950 underline-offset-2 hover:underline dark:text-sand-800"
                    >
                      {watch.tripTitle}
                    </Link>
                    <p className="mt-0.5 text-xs text-sand-600">
                      {watch.enabled
                        ? `Every ${watch.intervalMinutes} minutes · ${
                            watch.due ? "due now" : `next ${fmtDateTime(watch.nextRunAt)}`
                          }`
                        : "Paused — no automatic checks"}
                      {watch.lastRunAt ? ` · last ran ${fmtDateTime(watch.lastRunAt)}` : ""}
                      {" · "}alerts at {watch.alertMinSeverity} or worse
                    </p>
                  </div>
                  <div className="flex flex-none items-center gap-2">
                    {!watch.enabled && <StatusBadge status="PAUSED" tone="neutral" />}
                    <StatusBadge
                      status={watch.tripStatus}
                      tone={tripStatusTone(watch.tripStatus)}
                    />
                  </div>
                </div>
                {watch.lastError && (
                  <p className="mt-1.5 text-xs text-alert-600">
                    Last pass failed: {watch.lastError}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
