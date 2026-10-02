import Link from "next/link";
import { requireSession } from "@/app/require-auth";
import { getTripDigitalTwin, getTripEventHistory } from "@/modules/trip/trip-service";
import { getTripIndexStatus } from "@/modules/trip/rag-service";
import { getLatestTripRisk } from "@/modules/risk/risk-service";
import { listTripRecommendations } from "@/modules/risk/recommendation-service";
import { getTripWatch } from "@/modules/monitor/watch-service";
import { Card, EmptyState, SectionHeading, StatusBadge } from "@/components/ui";
import {
  documentStatusTone,
  recommendationStatusTone,
  riskSeverityTone,
  tripStatusTone,
} from "@/components/tone";
import {
  AddDestinationForm,
  AddFlightForm,
  AddTravelerForm,
  AssessRiskButton,
  ExplainRiskCard,
  CheckFlightStatusButton,
  CheckWeatherButton,
  CurrencyCheckForm,
  DocumentSearchForm,
  DocumentUploadForm,
  ResearchForm,
  RunMonitorButton,
  StatusSelect,
  TripWatchCard,
} from "./trip-actions";
import { OperationalStateBanner } from "./operational-state-banner";

function fmtDate(d: Date | string): string {
  return new Date(d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtDateTime(d: Date | string): string {
  return new Date(d).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The extracted metadata column is JSONB on purpose, so the shape
 * genuinely varies by document type. This reads the fact lists the
 * Phase 14 pipeline writes and ignores anything it doesn't recognize,
 * rather than assuming a fixed structure.
 */
interface DocumentFacts {
  pageCount: number | null;
  flightNumbers: string[];
  bookingReferences: string[];
  dates: string[];
}

function readDocumentFacts(metadata: Record<string, unknown> | null): DocumentFacts | null {
  if (!metadata) return null;

  const extraction = metadata.extraction as { pageCount?: unknown } | undefined;
  const values = (key: string): string[] => {
    const list = metadata[key];
    if (!Array.isArray(list)) return [];
    return list
      .map((fact) =>
        typeof fact === "object" && fact !== null && "value" in fact
          ? String((fact as { value: unknown }).value)
          : null,
      )
      .filter((value): value is string => Boolean(value));
  };

  return {
    pageCount: typeof extraction?.pageCount === "number" ? extraction.pageCount : null,
    flightNumbers: values("flightNumbers"),
    bookingReferences: values("bookingReferences"),
    dates: values("dates"),
  };
}

function hasFacts(facts: DocumentFacts): boolean {
  return (
    facts.flightNumbers.length > 0 || facts.bookingReferences.length > 0 || facts.dates.length > 0
  );
}

/**
 * The stored `factors` column is the risk model's own output, written by
 * the engine — so this reads its shape rather than recomputing anything.
 * Anything unrecognized is skipped instead of rendered as if it were a
 * scored factor.
 */
interface StoredRiskFactor {
  label?: unknown;
  points?: unknown;
  weight?: unknown;
  detail?: unknown;
  dataAvailable?: unknown;
}

function readRiskFactorLines(factors: unknown): string[] {
  if (!Array.isArray(factors)) return [];
  return factors.flatMap((entry) => {
    const factor = entry as StoredRiskFactor;
    if (typeof factor.label !== "string" || typeof factor.detail !== "string") return [];
    const scored = factor.dataAvailable === false ? " (not scored — no data)" : "";
    return [
      `${factor.label}: ${String(factor.points ?? "?")}/${String(factor.weight ?? "?")}${scored} — ${factor.detail}`,
    ];
  });
}

/**
 * The deterministic score a recommendation was written against, stored
 * in its evidence column. Returns null for a recommendation written
 * before that was recorded rather than showing a misleading number.
 */
function readRiskScore(evidence: Record<string, unknown>): number | null {
  const score = evidence.riskScore;
  return typeof score === "number" ? score : null;
}

export default async function TripDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession(`/trips/${id}`);

  const twin = await getTripDigitalTwin(id, user.id);
  const events = await getTripEventHistory(id, user.id);
  const { indexedChunks } = await getTripIndexStatus(id, user.id);
  const latestRisk = await getLatestTripRisk(id, user.id);
  const recommendations = await listTripRecommendations(id, user.id);
  const watch = await getTripWatch(id, user.id);
  const { trip, travelers, destinations, flights, documents } = twin;

  return (
    <div>
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/trips" className="text-sm text-sand-500 underline-offset-2 hover:underline">
            ← All trips
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-navy-950 dark:text-navy-100">
            {trip.title}
          </h1>
          <p className="mt-1 text-sm text-sand-600">
            {trip.startDate ? fmtDate(trip.startDate) : "No dates set"}
            {trip.endDate ? ` — ${fmtDate(trip.endDate)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={trip.status} tone={tripStatusTone(trip.status)} />
          <StatusSelect tripId={trip.id} current={trip.status} />
        </div>
      </div>

      {/* Operational state banner */}
      <OperationalStateBanner
        state={twin.operationalState.state}
        factors={twin.operationalState.factors}
        calculatedAt={twin.operationalState.calculatedAt}
      />

      {/* Two-column body */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Left column: destinations + travelers */}
        <div className="space-y-6">
          <Card>
            <SectionHeading>Destinations</SectionHeading>
            {destinations.length === 0 ? (
              <EmptyState>
                <span className="mt-2 block">No destinations yet — add the first below.</span>
              </EmptyState>
            ) : (
              <ul className="mt-3 space-y-2">
                {destinations.map((d) => (
                  <li
                    key={d.id}
                    className="flex items-start justify-between gap-3 rounded-lg border border-sand-200 p-3 dark:border-sand-200"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-navy-950 dark:text-navy-100">
                        {d.city}, {d.country}
                      </p>
                      <p className="mt-0.5 text-xs text-sand-500">
                        {d.arrivalDate ? `Arrive ${fmtDate(d.arrivalDate)}` : ""}
                        {d.arrivalDate && d.departureDate ? " · " : ""}
                        {d.departureDate ? `Leave ${fmtDate(d.departureDate)}` : ""}
                        {!d.arrivalDate && !d.departureDate ? "No dates" : ""}
                      </p>
                    </div>
                    <CheckWeatherButton tripId={trip.id} destinationId={d.id} />
                  </li>
                ))}
              </ul>
            )}
            <AddDestinationForm tripId={trip.id} />
          </Card>

          <Card>
            <SectionHeading>Travelers</SectionHeading>
            {travelers.length === 0 ? (
              <EmptyState>
                <span className="mt-2 block">No travelers yet.</span>
              </EmptyState>
            ) : (
              <ul className="mt-3 space-y-2">
                {travelers.map((t) => (
                  <li
                    key={t.id}
                    className="rounded-lg border border-sand-200 p-3 dark:border-sand-200"
                  >
                    <p className="font-medium text-navy-950 dark:text-navy-100">{t.fullName}</p>
                    <p className="mt-0.5 text-xs text-sand-500">
                      {t.dateOfBirth ? `DOB ${fmtDate(t.dateOfBirth)}` : "No DOB"}
                      {t.passportNumber ? ` · Passport on file` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <AddTravelerForm tripId={trip.id} />
          </Card>
        </div>

        {/* Right column: flights + AI agents */}
        <div className="space-y-6">
          <Card>
            <SectionHeading>Flights</SectionHeading>
            {flights.length === 0 ? (
              <EmptyState>
                <span className="mt-2 block">
                  No flights yet — add one below, then poll its live status.
                </span>
              </EmptyState>
            ) : (
              <ul className="mt-3 space-y-2">
                {flights.map((f) => (
                  <li
                    key={f.id}
                    className="rounded-lg border border-sand-200 p-3 dark:border-sand-200"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-navy-950 dark:text-navy-100">
                          {f.airline} · {f.flightNumber}
                        </p>
                        <p className="mt-0.5 text-xs text-sand-500">
                          {f.departureAirport} → {f.arrivalAirport} ·{" "}
                          {fmtDateTime(f.scheduledDeparture)}
                        </p>
                      </div>
                      <CheckFlightStatusButton tripId={trip.id} flightId={f.id} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <AddFlightForm tripId={trip.id} />
          </Card>

          <Card>
            <SectionHeading>Currency check</SectionHeading>
            <p className="mt-1.5 text-sm text-sand-600">
              Live rate via the Currency Agent (dual-vendor fallback), recorded as a timestamped
              snapshot on this trip.
            </p>
            <CurrencyCheckForm tripId={trip.id} />
          </Card>

          <Card>
            <SectionHeading>Ask the research agent</SectionHeading>
            <p className="mt-1.5 text-sm text-sand-600">
              Answers come only from live web search results, attributed to their sources — never
              from the model&apos;s memory.
            </p>
            <ResearchForm tripId={trip.id} />
          </Card>
        </div>
      </div>

      {/* Documents */}
      <Card className="mt-6">
        <SectionHeading>Documents</SectionHeading>
        <p className="mt-1.5 text-sm text-sand-600">
          Uploaded documents are stored through the document storage provider, then text-extracted.
          A document is only marked READY when extraction genuinely produced text.
        </p>
        <DocumentUploadForm tripId={trip.id} />
        {documents.length === 0 ? (
          <EmptyState>
            <span className="mt-3 block">No documents attached to this trip yet.</span>
          </EmptyState>
        ) : (
          <ul className="mt-4 space-y-2">
            {documents.map((doc) => {
              const facts = readDocumentFacts(doc.extractedMetadata);
              return (
                <li
                  key={doc.id}
                  className="rounded-lg border border-sand-200 p-3 dark:border-sand-200"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-navy-950 dark:text-navy-100">
                        {doc.originalFilename}
                      </p>
                      <p className="text-xs text-sand-500">
                        {doc.mimeType} · {(doc.sizeBytes / 1024).toFixed(0)} KB
                        {facts?.pageCount ? ` · ${facts.pageCount} page(s)` : ""}
                      </p>
                    </div>
                    <StatusBadge status={doc.status} tone={documentStatusTone(doc.status)} />
                  </div>
                  {doc.status === "FAILED" && doc.failureReason && (
                    <p className="mt-1.5 text-xs text-alert-600">{doc.failureReason}</p>
                  )}
                  {doc.status === "READY" && facts && hasFacts(facts) && (
                    <p className="mt-1.5 text-xs text-sand-600">
                      {facts.flightNumbers.length > 0 && (
                        <>Flights {facts.flightNumbers.join(", ")}. </>
                      )}
                      {facts.bookingReferences.length > 0 && (
                        <>Booking ref {facts.bookingReferences.join(", ")}. </>
                      )}
                      {facts.dates.length > 0 && <>Dates {facts.dates.join(", ")}.</>}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Document search (Phase 15 RAG) */}
      <Card className="mt-6">
        <SectionHeading>Search trip documents</SectionHeading>
        <p className="mt-1.5 text-sm text-sand-600">
          {indexedChunks > 0
            ? `Ranked retrieval over ${indexedChunks} indexed chunk${indexedChunks === 1 ? "" : "s"} from this trip\u2019s documents \u2014 real stored text, ordered by cosine similarity.`
            : "Nothing indexed yet. Upload a PDF that finishes text extraction and its content is indexed automatically."}
        </p>
        <DocumentSearchForm tripId={trip.id} />
      </Card>

      {/* Risk assessment (Phase 16) */}
      <Card className="mt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <SectionHeading>Risk assessment</SectionHeading>
            <p className="mt-1.5 text-sm text-sand-600">
              A deterministic weighted score over this trip&apos;s real flight, weather, schedule,
              and document data. No model writes the number — the same inputs always produce the
              same score.
            </p>
          </div>
          {latestRisk && (
            <StatusBadge
              status={latestRisk.severity}
              tone={riskSeverityTone(latestRisk.severity)}
            />
          )}
        </div>

        {latestRisk ? (
          <div className="mt-3 space-y-2">
            <p className="text-sm text-navy-950 dark:text-navy-100">
              Score <strong>{latestRisk.riskScore}/100</strong> ·{" "}
              {Number(latestRisk.confidence) === 1
                ? "all factors had data"
                : `confidence ${(Number(latestRisk.confidence) * 100).toFixed(0)}% — some factors had no data`}
            </p>
            <ul className="space-y-1 text-xs text-sand-500">
              {readRiskFactorLines(latestRisk.factors).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="text-xs text-sand-400">Generated {fmtDateTime(latestRisk.generatedAt)}</p>
          </div>
        ) : (
          <EmptyState>
            <span className="mt-2 block">No assessment yet — generate one to score this trip.</span>
          </EmptyState>
        )}
        <div className="mt-3">
          <AssessRiskButton tripId={trip.id} />
        </div>

        <div className="mt-5 border-t border-sand-200 pt-4 dark:border-sand-200">
          <SectionHeading>Trip Watch</SectionHeading>
          <p className="mt-1.5 text-sm text-sand-600">
            A monitoring pass re-checks every flight and destination against its provider,
            recomputes risk, and alerts you only when the risk genuinely changes. Watching a trip
            runs that pass automatically on the cadence you choose; repeated checks on an unchanged
            trip stay silent.
          </p>
          <TripWatchCard
            tripId={trip.id}
            dueNow={watch?.due ?? false}
            watch={
              watch
                ? {
                    enabled: watch.enabled,
                    intervalMinutes: watch.intervalMinutes,
                    alertMinSeverity: watch.alertMinSeverity,
                    lastRunAt: watch.lastRunAt ? watch.lastRunAt.toISOString() : null,
                    lastError: watch.lastError,
                    nextRunAt: watch.nextRunAt.toISOString(),
                  }
                : null
            }
          />
          <div className="mt-4">
            <RunMonitorButton tripId={trip.id} />
          </div>
          <p className="mt-3 text-xs text-sand-400">
            The button above always runs one pass now. Automatic checks are listed on the{" "}
            <Link href="/trips/watches" className="underline underline-offset-2">
              Trip Watch page
            </Link>
            .
          </p>
        </div>

        <div className="mt-5 border-t border-sand-200 pt-4 dark:border-sand-200">
          <SectionHeading>Explainable recommendation</SectionHeading>
          <ExplainRiskCard tripId={trip.id} />
        </div>

        {recommendations.length > 0 && (
          <div className="mt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-sand-500">
              Saved recommendations
            </p>
            <ul className="mt-2 space-y-2">
              {recommendations.map((rec) => (
                <li
                  key={rec.id}
                  className="rounded-lg border border-sand-200 p-3 dark:border-sand-200"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-medium text-navy-950 dark:text-navy-100">
                      {rec.decision}
                    </p>
                    <StatusBadge status={rec.status} tone={recommendationStatusTone(rec.status)} />
                  </div>
                  <p className="mt-1 text-sm text-sand-800 dark:text-sand-700">
                    {rec.recommendationText}
                  </p>
                  <p className="mt-1 text-xs text-sand-500">
                    {readRiskScore(rec.evidence) !== null && (
                      <>Risk {readRiskScore(rec.evidence)}/100 · </>
                    )}
                    confidence {(Number(rec.confidence) * 100).toFixed(0)}% ·{" "}
                    {fmtDateTime(rec.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {/* Event history */}
      <Card className="mt-6">
        <SectionHeading>Event history</SectionHeading>
        {events.length === 0 ? (
          <EmptyState>
            <span className="mt-2 block">No events recorded yet.</span>
          </EmptyState>
        ) : (
          <ul className="mt-3 divide-y divide-sand-200 dark:divide-sand-200">
            {events.map((event) => (
              <li key={event.id} className="py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-sm text-navy-950 dark:text-navy-100">
                      {event.eventType}
                    </p>
                    <p className="truncate text-xs text-sand-500">
                      {event.entityType}
                      {event.metadata ? ` · ${JSON.stringify(event.metadata)}` : ""}
                    </p>
                  </div>
                  <time className="flex-none text-xs text-sand-400">
                    {fmtDateTime(event.createdAt)}
                  </time>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
