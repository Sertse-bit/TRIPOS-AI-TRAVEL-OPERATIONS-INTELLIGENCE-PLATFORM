import type { Metadata } from "next";
import Link from "next/link";
import { LogoMark } from "@/components/auth-shell";
import { requireSession } from "@/app/require-auth";
import { TripsNav } from "./nav";

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
          <TripsNav />
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-sand-600 sm:inline">{user.email}</span>
            {/* Plain form POST: the route revokes the server-side session row,
                then the browser follows the redirect. No client JS needed. */}
            <form action="/logout" method="post">
              <button
                type="submit"
                className="rounded-md px-2.5 py-1.5 text-sm font-medium text-sand-600 transition hover:bg-sand-100 hover:text-sand-800 dark:text-sand-600 dark:hover:bg-sand-100"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main id="main-content" className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        {children}
      </main>

      <footer className="border-t border-sand-200 px-6 py-4 text-center text-xs text-sand-600 dark:border-sand-200">
        TripOS — AI Travel Operations &amp; Intelligence Platform
      </footer>
    </div>
  );
}
