"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { currentNavHref, TRIPS_NAV } from "./nav-links";

/**
 * The trips shell's primary nav (Phase 25). A client island purely so the
 * current page can be marked with `aria-current="page"` — a server
 * component has no pathname. The hover/tone classes are the same ones the
 * inline version used; the current link additionally gets the background
 * it would show on hover, so the marker is not indicated by colour alone.
 */
export function TripsNav() {
  const pathname = usePathname();
  const current = currentNavHref(pathname);

  return (
    <nav aria-label="Primary" className="flex items-center gap-1">
      {TRIPS_NAV.map((item) => {
        const isCurrent = item.href === current;
        const base = item.emphasis
          ? "text-navy-800 hover:bg-navy-100 dark:text-sand-800 dark:hover:bg-navy-100"
          : "text-sand-600 hover:bg-sand-100 hover:text-sand-800 dark:text-sand-600 dark:hover:bg-sand-100";
        const currentClasses = isCurrent
          ? " bg-sand-100 text-sand-800 dark:bg-sand-100 dark:text-sand-800"
          : "";
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isCurrent ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${base}${currentClasses}`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
