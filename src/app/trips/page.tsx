import Link from "next/link";
import { requireSession } from "@/app/require-auth";
import { listUserTrips } from "@/modules/trip/trip-service";
import { Card, StatusBadge } from "@/components/ui";
import { tripStatusTone } from "@/components/tone";
import { NewTripForm } from "./new-trip-form";

export default async function TripsPage() {
  const user = await requireSession("/trips");
  const trips = await listUserTrips(user.id);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-navy-950 dark:text-sand-800">
            My trips
          </h1>
          <p className="mt-1 text-sm text-sand-600">
            Every trip is a live digital twin: destinations, flights, travelers, documents, and
            operational state in one place.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-3">
          {trips.length === 0 ? (
            <Card className="border-dashed text-center dark:bg-transparent">
              <p className="text-sm font-medium text-sand-700 dark:text-sand-600">No trips yet.</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-sand-600">
                Create your first trip to start tracking destinations, flights, and live operational
                state.
              </p>
            </Card>
          ) : (
            trips.map((trip) => (
              <Link key={trip.id} href={`/trips/${trip.id}`} className="block">
                <Card className="transition hover:border-navy-500/40 hover:shadow-md">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-navy-950 dark:text-sand-800">
                        {trip.title}
                      </p>
                      <p className="mt-0.5 text-xs text-sand-600">
                        {trip.startDate
                          ? `Starts ${new Date(trip.startDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
                          : "No dates set"}
                        {" · "}
                        Created {new Date(trip.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <StatusBadge status={trip.status} tone={tripStatusTone(trip.status)} />
                  </div>
                </Card>
              </Link>
            ))
          )}
        </div>

        <aside className="space-y-4">
          <Card>
            <h2 className="text-xs font-semibold uppercase tracking-widest text-navy-700 dark:text-navy-500">
              New trip
            </h2>
            <p className="mt-1.5 text-sm text-sand-600">
              Name it now; add destinations, travelers, and flights on the next screen.
            </p>
            <NewTripForm />
          </Card>
          <Card className="bg-navy-100/60 dark:bg-navy-100/60">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-navy-700 dark:text-navy-500">
              How TripOS works
            </h2>
            <ul className="mt-2 space-y-1.5 text-sm text-sand-700 dark:text-sand-600">
              <li>• Add destinations and flights to build the digital twin.</li>
              <li>• AI agents poll flight status, weather, and currency rates.</li>
              <li>• Operational state updates from real provider data — never invented.</li>
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  );
}
