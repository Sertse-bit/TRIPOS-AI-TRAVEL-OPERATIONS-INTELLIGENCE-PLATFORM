"use client";

import { useId, useState, type ReactNode } from "react";
import type { Tone } from "@/components/tone";

/* ------------------------------------------------------------------ */
/* Shared client UI primitives for the TripOS frontend.                */
/* Server components never import from here — it exists so the         */
/* interactive islands (forms, selects, buttons) stay consistent.      */
/*                                                                    */
/* Note: pure helpers like tripStatusTone() live in components/tone.ts */
/* instead, because a server component cannot CALL a function exported */
/* from a "use client" module — only render it. See that file's header.*/
/* ------------------------------------------------------------------ */

export type { Tone };

// --- API helper (all routes use the { data, requestId } / { error } envelope) ---

export interface ApiError {
  code: string;
  message: string;
  requestId: string;
  details?: unknown;
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = await res.json();

  if (!res.ok || body.error) {
    const err: ApiError | undefined = body.error;
    const message =
      err?.message ??
      (Array.isArray(err?.details) && err.details.length > 0
        ? err.details.map((d: { message?: string }) => d.message).join("; ")
        : `Request failed (${res.status}).`);
    throw new Error(message);
  }
  return body.data as T;
}

// --- Button ---

export function Button({
  children,
  onClick,
  type = "button",
  disabled = false,
  busy = false,
  variant = "primary",
  className = "",
}: {
  children: ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  type?: "button" | "submit";
  disabled?: boolean;
  /**
   * Phase 25: a request is in flight. Kept separate from `disabled` so the
   * state is announced (`aria-busy`) rather than only blocking the click —
   * an assistive-technology user otherwise gets a button that silently
   * stops responding, with no explanation.
   */
  busy?: boolean;
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
}) {
  const styles = {
    primary: "bg-navy-900 text-white hover:bg-navy-800 dark:bg-navy-700 dark:hover:bg-navy-600",
    secondary:
      "border border-sand-300 bg-sand-50 text-sand-800 hover:bg-sand-100 dark:bg-sand-100 dark:text-sand-800 dark:border-sand-200 dark:hover:bg-sand-200",
    ghost:
      "text-sand-600 hover:bg-sand-100 hover:text-sand-800 dark:text-sand-600 dark:hover:bg-sand-100",
  }[variant];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

// --- Form field wrappers ---

export function TextField({
  label,
  name,
  type = "text",
  required = false,
  maxLength,
  minLength,
  placeholder,
  autoComplete,
  defaultValue,
  className = "",
  onChange,
  error = null,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  maxLength?: number;
  placeholder?: string;
  autoComplete?: string;
  defaultValue?: string;
  className?: string;
  minLength?: number;
  onChange?: (value: string) => void;
  /** A field-level message; announced and programmatically linked. */
  error?: string | null;
}) {
  // Explicit label association (Phase 25). The wrapping-label form was
  // valid, but an id pairing lets the field also point AT its error text
  // via aria-describedby, which a wrapper label cannot express.
  const inputId = useId();
  const errorId = `${inputId}-error`;

  return (
    <div className={`flex flex-col gap-1 text-sm ${className}`}>
      <label htmlFor={inputId} className="font-medium text-sand-700 dark:text-sand-600">
        {label}
      </label>
      <input
        id={inputId}
        name={name}
        type={type}
        required={required}
        maxLength={maxLength}
        minLength={minLength}
        placeholder={placeholder}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        className="h-10 w-full rounded-md border border-sand-300 bg-white px-3 text-sm text-foreground outline-none transition placeholder:text-sand-600 focus:border-navy-500 focus:ring-2 focus:ring-navy-200/60 dark:border-sand-200 dark:bg-sand-50"
      />
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-alert-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function FormMessage({
  message,
}: {
  message: { type: "error" | "success"; text: string } | null;
}) {
  if (!message) return null;
  return (
    <p
      // Errors interrupt; successes wait their turn (Phase 25). Both are
      // live regions, so a submit result is announced instead of only
      // appearing on screen.
      role={message.type === "error" ? "alert" : "status"}
      className={`text-sm ${message.type === "error" ? "text-alert-600" : "text-ok-600"}`}
    >
      {message.text}
    </p>
  );
}

// --- Status / tone badges ---

export function StatusBadge({ status, tone }: { status: string; tone: Tone }) {
  const styles = {
    ok: "bg-ok-100 text-ok-700 dark:text-ok-500",
    warn: "bg-warn-100 text-warn-700 dark:text-warn-500",
    alert: "bg-alert-100 text-alert-700 dark:text-alert-500",
    neutral: "bg-navy-100 text-navy-700 dark:text-navy-500",
  }[tone];

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${styles}`}
    >
      {status}
    </span>
  );
}

// --- Section heading ---

export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-widest text-navy-700 dark:text-navy-500">
      {children}
    </h2>
  );
}

// --- Card ---

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-sand-200 bg-white p-5 shadow-sm dark:border-sand-200 dark:bg-sand-50 ${className}`}
    >
      {children}
    </div>
  );
}

// --- Empty state ---

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="text-sm text-sand-600">{children}</p>;
}

// --- Error boundary helper (small, client-side) ---

export function InlineError({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-alert-600">
      {error.message}
    </p>
  );
}

// --- useAsyncAction: small wrapper for POST/PATCH flows ---

export function useAsyncAction() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setMessage(null);
    try {
      return await fn();
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Something went wrong.",
      });
      return null;
    } finally {
      setBusy(false);
    }
  }

  return { busy, message, setMessage, run };
}
