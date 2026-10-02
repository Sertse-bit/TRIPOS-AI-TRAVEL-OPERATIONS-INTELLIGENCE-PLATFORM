import type { Metadata } from "next";
import Link from "next/link";
import { LogoMark } from "@/components/auth-shell";
import { requireSession } from "@/app/require-auth";

export const metadata: Metadata = {
  title: "Trips — TripOS",
  description: "Your TripOS command center.",
};

export default async function TripsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSession("/trips");

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-sand-200 bg-sand-50/90 backdrop-blur dark:border-sand-200 dark:bg-sand-50/90">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-3">
          <Link href="/trips">
            <LogoMark />
          </Link>
          <nav className="flex items-center gap-1">
            <Link
              href="/trips"
              className="rounded-md px-3 py-1.5 text-sm font-medium text-navy-800 transition hover:bg-navy-100 dark:text-navy-100 dark:hover:bg-navy-100"
            >
              Trips
            </Link>
            <Link
              href="/trips/watches"
              className="rounded-md px-3 py-1.5 text-sm font-medium text-sand-600 transition hover:bg-sand-100 hover:text-sand-800 dark:text-sand-500 dark:hover:bg-sand-100"
            >
              Watch
            </Link>
            <Link
              href="/trips/notifications"
              className="rounded-md px-3 py-1.5 text-sm font-medium text-sand-600 transition hover:bg-sand-100 hover:text-sand-800 dark:text-sand-500 dark:hover:bg-sand-100"
            >
              Alerts
            </Link>
            <Link
              href="/trips/analytics"
              className="rounded-md px-3 py-1.5 text-sm font-medium text-sand-600 transition hover:bg-sand-100 hover:text-sand-800 dark:text-sand-500 dark:hover:bg-sand-100"
            >
              Analytics
            </Link>
            <Link
              href="/trips/settings"
              className="rounded-md px-3 py-1.5 text-sm font-medium text-sand-600 transition hover:bg-sand-100 hover:text-sand-800 dark:text-sand-500 dark:hover:bg-sand-100"
            >
              Settings
            </Link>
          </nav>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-sand-500 sm:inline">{user.email}</span>
            {/* Plain form POST: the route revokes the server-side session row,
                then the browser follows the redirect. No client JS needed. */}
            <form action="/logout" method="post">
              <button
                type="submit"
                className="rounded-md px-2.5 py-1.5 text-sm font-medium text-sand-600 transition hover:bg-sand-100 hover:text-sand-800 dark:text-sand-500 dark:hover:bg-sand-100"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>

      <footer className="border-t border-sand-200 px-6 py-4 text-center text-xs text-sand-400 dark:border-sand-200">
        TripOS — AI Travel Operations &amp; Intelligence Platform
      </footer>
    </div>
  );
}
