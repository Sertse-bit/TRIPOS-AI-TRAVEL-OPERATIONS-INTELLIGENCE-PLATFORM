import { requireSession } from "@/app/require-auth";
import { getUserTripEntityCounts, listUserTrips } from "@/modules/trip/trip-service";
import { Card, SectionHeading, StatusBadge } from "@/components/ui";
import { tripStatusTone } from "@/components/tone";

export default async function AnalyticsPage() {
  const user = await requireSession("/trips/analytics");

  // Real aggregates computed from the user's actual trips — every value
  // traces to a DB row; nothing is invented.
  //
  // Phase 29: the counts come from one aggregate query rather than a
  // digital twin per trip (which was ~12 queries per trip for four
  // integers — measured, then fixed; see scripts/bench-read-paths.ts).
  // The trip list is still a separate read because the status breakdown
  // below renders each trip, not just its count.
  const [trips, counts] = await Promise.all([
    listUserTrips(user.id),
    getUserTripEntityCounts(user.id),
  ]);

  const stats = [
    { label: "Trips", value: counts.trips },
    { label: "Destinations", value: counts.destinations },
    { label: "Flights", value: counts.flights },
    { label: "Travelers", value: counts.travelers },
  ];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-navy-950 dark:text-sand-800">
        Analytics
      </h1>
      <p className="mt-1 text-sm text-sand-600">
        Live counts computed from your trips — no cached or invented metrics.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <p className="text-3xl font-semibold tracking-tight text-navy-950 dark:text-sand-800">
              {s.value}
            </p>
            <p className="mt-1 text-xs font-medium uppercase tracking-widest text-sand-600">
              {s.label}
            </p>
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <SectionHeading>Trips by status</SectionHeading>
        {trips.length === 0 ? (
          <p className="mt-2 text-sm text-sand-600">No trips yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {trips.map((trip) => (
              <li key={trip.id} className="flex items-center justify-between gap-3">
                <span className="truncate text-sm text-sand-700 dark:text-sand-600">
                  {trip.title}
                </span>
                <StatusBadge status={trip.status} tone={tripStatusTone(trip.status)} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
