import Link from "next/link";
import { LogoMark } from "@/components/auth-shell";

const FEATURES = [
  {
    name: "Trip Digital Twin",
    description:
      "One source of truth per trip: destinations, travelers, flights, documents, and operational state, assembled server-side from the trip service on every load.",
  },
  {
    name: "Live agent polling",
    description:
      "Flight status, weather, and currency agents pull real provider data and record timestamped snapshots. Disruptions surface in the operational state banner.",
  },
  {
    name: "Explainable AI",
    description:
      "The research agent answers only from retrieved, attributed sources — and says so when the evidence is thin. No invented facts, ever.",
  },
  {
    name: "Operational readiness",
    description:
      "Every trip shows a deterministic operational state — INCOMPLETE, ON TRACK, ATTENTION NEEDED, or DISRUPTED — computed from real flight snapshots.",
  },
];

export default function Home() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/">
          <LogoMark />
        </Link>
        <nav aria-label="Primary" className="flex items-center gap-3">
          <Link
            href="/trips"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-sand-600 transition hover:bg-sand-100 hover:text-sand-800 dark:text-sand-600 dark:hover:bg-sand-100"
          >
            Command Center
          </Link>
          <Link
            href="/login"
            className="rounded-md bg-navy-900 px-3.5 py-1.5 text-sm font-semibold text-white transition hover:bg-navy-800 dark:bg-navy-700 dark:hover:bg-navy-600"
          >
            Sign in
          </Link>
        </nav>
      </header>

      <main id="main-content" className="mx-auto w-full max-w-6xl flex-1 px-6 pb-16">
        {/* Hero */}
        <section className="grid items-center gap-10 md:grid-cols-2">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full bg-navy-100 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-navy-700 dark:text-navy-500">
              AI Travel Operations
            </span>
            <h1 className="mt-5 text-4xl font-semibold leading-[1.08] tracking-tight text-navy-950 dark:text-sand-800 md:text-5xl">
              The command center for
              <span className="text-navy-700 dark:text-navy-500"> every trip.</span>
            </h1>
            <p className="mt-5 max-w-md text-base leading-relaxed text-sand-600">
              TripOS orchestrates live travel data, specialized AI agents, and document intelligence
              into one explainable operational view. Plan, monitor, and de-risk trips from a single
              page.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link
                href="/login"
                className="inline-flex items-center gap-2 rounded-md bg-navy-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-navy-800 dark:bg-navy-700 dark:hover:bg-navy-600"
              >
                Open command center
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 12h14" />
                  <path d="M13 6l6 6-6 6" />
                </svg>
              </Link>
              <Link
                href="/register"
                className="inline-flex items-center gap-2 rounded-md border border-sand-300 bg-white px-5 py-2.5 text-sm font-semibold text-sand-800 transition hover:bg-sand-100 dark:border-sand-200 dark:bg-sand-50 dark:text-sand-800"
              >
                Create account
              </Link>
            </div>
            <p className="mt-5 text-xs text-sand-600">
              Free to try. Sessions are DB-backed, hashed, and revocable.
            </p>
          </div>

          {/* Hero visual: a stylized trip board */}
          <div className="relative">
            <div className="overflow-hidden rounded-xl border border-sand-200 bg-white shadow-lg shadow-navy-900/5 dark:border-sand-200 dark:bg-sand-50">
              <div className="flex items-center gap-1.5 border-b border-sand-200 px-4 py-3 dark:border-sand-200">
                <span className="h-2.5 w-2.5 rounded-full bg-ok-500" />
                <span className="h-2.5 w-2.5 rounded-full bg-warn-500" />
                <span className="h-2.5 w-2.5 rounded-full bg-alert-500" />
                <span className="ml-3 font-mono text-xs text-sand-600">trip-7 · digital twin</span>
              </div>
              <div className="space-y-2 p-4">
                {[
                  { label: "Operational state", value: "ON TRACK", tone: "ok" as const },
                  { label: "Destinations", value: "Lisbon → Porto → Madeira", tone: null },
                  { label: "Flights", value: "TP 1353 · SCHEDULED", tone: null },
                  { label: "Weather · Lisbon", value: "22°C · clear", tone: null },
                  { label: "Rate · USD/EUR", value: "0.9214", tone: null },
                ].map((item) => (
                  <div
                    key={item.label}
                    className="flex items-center justify-between rounded-md px-3 py-2 transition hover:bg-sand-100 dark:hover:bg-sand-100"
                  >
                    <div>
                      <p className="text-xs font-medium text-sand-600">{item.label}</p>
                      <p
                        className={`text-sm font-semibold ${
                          item.tone === "ok" ? "text-ok-600" : "text-navy-950 dark:text-sand-800"
                        }`}
                      >
                        {item.value}
                      </p>
                    </div>
                    {item.tone === "ok" && (
                      <span className="rounded-full bg-ok-100 px-2 py-0.5 text-xs font-semibold text-ok-700 dark:text-ok-500">
                        LIVE
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="pointer-events-none absolute -bottom-4 -right-4 h-24 w-24 rounded-full border-2 border-navy-700/30 opacity-50" />
          </div>
        </section>

        {/* Features */}
        <section className="mt-16">
          <h2 className="text-2xl font-semibold tracking-tight text-navy-950 dark:text-sand-800">
            Built for the whole trip, not just the itinerary
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-sand-600">
            The dashboard is a thin client over the trip service: server components render the
            digital twin directly from the database, and the AI islands post to authenticated
            endpoints and refresh server state — no duplicated client caches.
          </p>

          <div className="mt-8 grid gap-5 sm:grid-cols-2">
            {FEATURES.map((feature) => (
              <div
                key={feature.name}
                className="rounded-xl border border-sand-200 bg-white p-5 transition hover:border-navy-500/40 hover:shadow-sm dark:border-sand-200 dark:bg-sand-50"
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-navy-100 text-navy-700 dark:text-navy-500">
                    <svg
                      aria-hidden="true"
                      className="h-4 w-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                  </span>
                  <div>
                    <h3 className="font-semibold text-navy-950 dark:text-sand-800">
                      {feature.name}
                    </h3>
                    <p className="mt-1 text-sm text-sand-600">{feature.description}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* CTA band */}
        <section className="mt-16 rounded-xl border border-sand-200 bg-sand-100/60 p-6 dark:border-sand-200 dark:bg-sand-100/60 md:p-8">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-navy-950 dark:text-sand-800">
                Ready to run your trips like operations?
              </h2>
              <p className="mt-1 text-sm text-sand-600">
                Create a free account, add your first trip, and watch the agents start polling.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/register"
                className="inline-flex items-center gap-2 rounded-md bg-navy-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-navy-800 dark:bg-navy-700 dark:hover:bg-navy-600"
              >
                Get started
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center rounded-md border border-sand-300 bg-white px-5 py-2.5 text-sm font-semibold text-sand-800 transition hover:bg-sand-100 dark:border-sand-200 dark:bg-sand-50 dark:text-sand-800"
              >
                Sign in
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-sand-200 px-6 py-6 text-center text-xs text-sand-600 dark:border-sand-200">
        TripOS — AI Travel Operations &amp; Intelligence Platform.
        <br />
        Next.js 16 · Postgres repositories · typed AI tool layer.
      </footer>
    </div>
  );
}
