import { requireSession } from "@/app/require-auth";
import { listUserTrips, getTripDigitalTwin } from "@/modules/trip/trip-service";
import { Card, SectionHeading, StatusBadge } from "@/components/ui";
import { tripStatusTone } from "@/components/tone";

export default async function AnalyticsPage() {
  const user = await requireSession("/trips/analytics");
  const trips = await listUserTrips(user.id);

  // Real aggregates computed from the user's actual trips — every value
  // traces to a DB row; nothing is invented.
  let destinationCount = 0;
  let flightCount = 0;
  let travelerCount = 0;
  for (const trip of trips) {
    const twin = await getTripDigitalTwin(trip.id, user.id);
    destinationCount += twin.destinations.length;
    flightCount += twin.flights.length;
    travelerCount += twin.travelers.length;
  }

  const stats = [
    { label: "Trips", value: trips.length },
    { label: "Destinations", value: destinationCount },
    { label: "Flights", value: flightCount },
    { label: "Travelers", value: travelerCount },
  ];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-navy-950 dark:text-navy-100">
        Analytics
      </h1>
      <p className="mt-1 text-sm text-sand-600">
        Live counts computed from your trips — no cached or invented metrics.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <p className="text-3xl font-semibold tracking-tight text-navy-950 dark:text-navy-100">
              {s.value}
            </p>
            <p className="mt-1 text-xs font-medium uppercase tracking-widest text-sand-500">
              {s.label}
            </p>
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <SectionHeading>Trips by status</SectionHeading>
        {trips.length === 0 ? (
          <p className="mt-2 text-sm text-sand-500">No trips yet.</p>
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
