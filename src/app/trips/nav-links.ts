/**
 * The trips-shell navigation, as data (Phase 25).
 *
 * The nav lives here rather than inline in the layout so that two things
 * are testable without a DOM: the item list the shell renders, and the
 * "which one is the current page" rule below. The client island
 * (`nav.tsx`) consumes both; nothing here is a client module, so it
 * stays callable from tests and from server code.
 */

export interface NavItem {
  href: string;
  label: string;
  /** Rendered with the stronger navy tone, as the section root. */
  emphasis?: boolean;
}

export const TRIPS_NAV: NavItem[] = [
  { href: "/trips", label: "Trips", emphasis: true },
  { href: "/trips/watches", label: "Watch" },
  { href: "/trips/notifications", label: "Alerts" },
  { href: "/trips/analytics", label: "Analytics" },
  { href: "/trips/audit", label: "Audit" },
  { href: "/trips/observability", label: "System" },
  { href: "/trips/settings", label: "Settings" },
];

/**
 * The href of the single nav item that should carry `aria-current="page"`
 * for a pathname, or null when the path is outside the trips shell.
 *
 * Longest match wins so exactly one link is ever current: on
 * `/trips/audit` the section root `/trips` also matches by prefix, but
 * `/trips/audit` is the more specific answer. A page inside the section
 * with no entry of its own (`/trips/<id>`) keeps the section root
 * current, which is the honest description of where the user is.
 */
export function currentNavHref(pathname: string, items: NavItem[] = TRIPS_NAV): string | null {
  let best: string | null = null;
  for (const item of items) {
    const matches = pathname === item.href || pathname.startsWith(`${item.href}/`);
    if (matches && (best === null || item.href.length > best.length)) {
      best = item.href;
    }
  }
  return best;
}
