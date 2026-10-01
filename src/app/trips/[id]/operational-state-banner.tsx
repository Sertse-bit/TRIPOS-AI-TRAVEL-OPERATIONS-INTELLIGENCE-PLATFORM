import { SectionHeading, StatusBadge, type Tone } from "@/components/ui";

/**
 * Operational state banner on the trip detail page. Server component —
 * the state comes from `calculateOperationalState` in the digital twin
 * assembly, and nothing here needs interactivity.
 */
export function OperationalStateBanner({
  state,
  factors,
  calculatedAt,
}: {
  state: string;
  factors: string[];
  calculatedAt: string;
}) {
  const tone: Tone =
    state === "ON_TRACK"
      ? "ok"
      : state === "ATTENTION_NEEDED"
        ? "warn"
        : state === "DISRUPTED"
          ? "alert"
          : "neutral";

  const label =
    state === "ON_TRACK"
      ? "On track"
      : state === "ATTENTION_NEEDED"
        ? "Attention needed"
        : state === "DISRUPTED"
          ? "Disrupted"
          : "Incomplete";

  return (
    <div
      className={`mt-6 rounded-xl border p-4 ${
        tone === "ok"
          ? "border-ok-500/30 bg-ok-100/60 dark:bg-ok-100/60"
          : tone === "warn"
            ? "border-warn-500/30 bg-warn-100/60 dark:bg-warn-100/60"
            : tone === "alert"
              ? "border-alert-500/30 bg-alert-100/60 dark:bg-alert-100/60"
              : "border-sand-200 bg-sand-100/60 dark:bg-sand-100/60"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionHeading>Operational state</SectionHeading>
        <StatusBadge status={label} tone={tone} />
      </div>
      <ul className="mt-2 space-y-1 text-sm text-sand-700 dark:text-sand-600">
        {factors.map((f) => (
          <li key={f}>• {f}</li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-sand-400">
        Calculated {new Date(calculatedAt).toLocaleTimeString()} from the trip&apos;s flights and
        destinations.
      </p>
    </div>
  );
}
