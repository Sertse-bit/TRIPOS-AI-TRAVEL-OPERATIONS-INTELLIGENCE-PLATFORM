import Link from "next/link";
import type { ReactNode } from "react";

export function LogoMark({ size = "md" }: { size?: "md" | "sm" }) {
  const box = size === "md" ? "h-7 w-7" : "h-6 w-6";
  const icon = size === "md" ? "h-4 w-4" : "h-3.5 w-3.5";

  return (
    <span className="flex items-center gap-2.5">
      <span
        className={`flex ${box} items-center justify-center rounded-md bg-navy-900 text-white dark:bg-navy-700`}
      >
        <svg
          // Decorative: the wordmark's text already names the link, so the
          // glyph is hidden from assistive tech rather than announced.
          aria-hidden="true"
          className={icon}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </span>
      <span className="text-base font-semibold tracking-tight text-navy-950 dark:text-sand-800">
        Trip<span className="text-navy-700 dark:text-navy-500">OS</span>
      </span>
    </span>
  );
}

/**
 * Shared shell for /login and /register. Centered card over the sand
 * background, with the product wordmark above the form and a link back
 * to the landing page. `footer` is the small cross-link between the two
 * auth pages.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="mx-auto w-full max-w-md px-6 pt-8">
        <Link href="/" className="inline-block">
          <LogoMark />
        </Link>
      </header>

      <main id="main-content" className="mx-auto w-full max-w-md flex-1 px-6 pb-16 pt-10">
        <div className="rounded-xl border border-sand-200 bg-white p-6 shadow-sm dark:border-sand-200 dark:bg-sand-50 md:p-8">
          <h1 className="text-xl font-semibold tracking-tight text-navy-950 dark:text-sand-800">
            {title}
          </h1>
          <p className="mt-1.5 text-sm text-sand-600">{subtitle}</p>
          {children}
        </div>
        <div className="mt-4 text-center text-sm text-sand-600">{footer}</div>
      </main>

      <footer className="border-t border-sand-200 px-6 py-4 text-center text-xs text-sand-600 dark:border-sand-200">
        Sessions are hashed server-side, stored in Postgres, and revocable.
      </footer>
    </div>
  );
}
