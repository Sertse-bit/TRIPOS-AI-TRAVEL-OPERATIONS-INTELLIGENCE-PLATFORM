import { requireSession } from "@/app/require-auth";
import { getSystemObservability } from "@/modules/observability/observability-service";
import { Card, SectionHeading, StatusBadge } from "@/components/ui";
import { apiHealthTone, circuitStateTone } from "@/components/tone";
import { RefreshObservabilityButton } from "./refresh-button";

/**
 * Phase 23 — System Observability. A server component rendering the
 * report assembled in observability-service.ts: real provider health
 * rows written by the resilience layer, real in-process circuit states,
 * and measured database/Redis reachability. Every value on this page was
 * either measured at request time or recorded after a genuine provider
 * attempt — none of it is a placeholder.
 */

function fmtDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function SummaryStat({
  label,
  value,
  tone = "text-navy-950 dark:text-sand-800",
}: {
  label: string;
  value: string | number;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border border-sand-200 p-3 dark:border-sand-200">
      <p className="text-xs font-semibold uppercase tracking-wide text-sand-600">{label}</p>
      <p className={`mt-1 text-xl font-semibold tracking-tight ${tone}`}>{value}</p>
    </div>
  );
}

export default async function ObservabilityPage() {
  await requireSession("/trips/observability");
  const report = await getSystemObservability();

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-navy-950 dark:text-sand-800">
            System observability
          </h1>
          <p className="mt-1 text-sm text-sand-600">
            Real health for every provider and infrastructure dependency. Checked{" "}
            {fmtDateTime(report.checkedAt)}.
          </p>
        </div>
        <RefreshObservabilityButton />
      </div>

      {/* Summary */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <SummaryStat label="Providers tracked" value={report.summary.providers} />
        <SummaryStat label="Configured" value={report.summary.configured} />
        <SummaryStat label="Operational" value={report.summary.operational} tone="text-ok-600" />
        <SummaryStat
          label="Degraded / down"
          value={`${report.summary.degraded} / ${report.summary.down}`}
          tone={report.summary.down > 0 ? "text-alert-600" : "text-warn-700"}
        />
        <SummaryStat label="Never exercised" value={report.summary.neverExercised} />
      </div>

      {/* Infrastructure */}
      <Card className="mt-6">
        <SectionHeading>Infrastructure</SectionHeading>
        <p className="mt-1.5 text-sm text-sand-600">
          Measured at request time — each check performs the real round trip and reports how long it
          took.
        </p>
        <ul className="mt-3 space-y-2">
          {report.infrastructure.map((check) => (
            <li
              key={check.name}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sand-200 p-3 dark:border-sand-200"
            >
              <div className="min-w-0">
                <p className="font-medium capitalize text-navy-950 dark:text-sand-800">
                  {check.name}
                </p>
                {check.error && (
                  <p className="mt-0.5 break-words text-xs text-alert-600">{check.error}</p>
                )}
              </div>
              <span className="text-sm">
                {check.reachable ? (
                  <span className="font-semibold text-ok-600">
                    reachable · {check.latencyMs} ms
                  </span>
                ) : (
                  <span className="font-semibold text-alert-600">unreachable</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      {/* Providers */}
      <Card className="mt-6">
        <SectionHeading>Providers</SectionHeading>
        <p className="mt-1.5 text-sm text-sand-600">
          Health is recorded by the resilience layer after a real call attempt — a success, a
          failure, or a fallback. “Never exercised” means no call has been made yet in this
          database: it is not a health claim.
        </p>
        <ul className="mt-3 divide-y divide-sand-200 dark:divide-sand-200">
          {report.providers.map((provider) => (
            <li key={provider.provider} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium text-navy-950 dark:text-sand-800">
                    {provider.provider}
                  </span>
                  {provider.configured ? (
                    <span className="rounded-full bg-navy-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-navy-600 dark:text-navy-500">
                      configured
                    </span>
                  ) : (
                    <span className="rounded-full bg-sand-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sand-600">
                      not configured
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {provider.health ? (
                    <StatusBadge
                      status={provider.health.status}
                      tone={apiHealthTone(provider.health.status)}
                    />
                  ) : (
                    <span className="text-xs text-sand-600">never exercised</span>
                  )}
                  {provider.circuit ? (
                    <StatusBadge
                      status={`circuit ${provider.circuit.state}`}
                      tone={circuitStateTone(provider.circuit.state)}
                    />
                  ) : (
                    <span className="text-xs text-sand-600">no circuit activity</span>
                  )}
                </div>
              </div>
              <p className="mt-1 text-xs text-sand-600">
                {provider.health ? (
                  <>
                    {provider.health.consecutiveFailures} consecutive failure
                    {provider.health.consecutiveFailures === 1 ? "" : "s"} · last check{" "}
                    {fmtDateTime(provider.health.lastCheckedAt)}
                    {provider.health.lastSuccessAt
                      ? ` · last success ${fmtDateTime(provider.health.lastSuccessAt)}`
                      : " · no successful call recorded"}
                    {provider.health.lastFailureAt
                      ? ` · last failure ${fmtDateTime(provider.health.lastFailureAt)}`
                      : ""}
                  </>
                ) : (
                  <>
                    No recorded provider attempt yet
                    {provider.circuit
                      ? ` — circuit has seen ${provider.circuit.consecutiveFailures} failure${provider.circuit.consecutiveFailures === 1 ? "" : "s"} in this process.`
                      : "."}
                  </>
                )}
              </p>
            </li>
          ))}
        </ul>
      </Card>

      {/* Where these numbers come from */}
      <Card className="mt-6">
        <SectionHeading>How to read this panel</SectionHeading>
        <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-sand-600">
          <li>
            Health rows are written by the resilience layer (
            <code className="font-mono text-xs">api_health</code>) only after a real provider call
            is attempted, so an untouched provider is reported as never exercised rather than
            assumed healthy.
          </li>
          <li>
            The 1–2 consecutive failures = DEGRADED / 3+ = DOWN thresholds are the repository&apos;s
            documented reporting rule, distinct from the circuit breaker&apos;s own attempt
            threshold (5) — the panel reflects trouble before the circuit actually opens.
          </li>
          <li>
            Circuit state is per-process memory of this running instance; the app runs as a single
            Next.js server, so there is no cross-instance state to show yet.
          </li>
          <li>
            This panel deliberately shows no CPU/memory graphs or log viewer: no metrics pipeline
            exists in this build, and inventing one would violate the project&apos;s
            no-fabricated-metrics rule.
          </li>
        </ul>
      </Card>
    </div>
  );
}
