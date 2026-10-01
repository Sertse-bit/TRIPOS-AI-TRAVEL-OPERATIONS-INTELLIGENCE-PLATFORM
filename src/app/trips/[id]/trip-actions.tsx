"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { Button, FormMessage, useAsyncAction } from "@/components/ui";

/* ------------------------------------------------------------------ */
/* Client islands for the trip detail page. Each posts to the real     */
/* API routes (session cookie rides along) and refreshes the server    */
/* component tree on success so the page re-renders from the DB.       */
/* ------------------------------------------------------------------ */

const inputClass =
  "h-10 w-full rounded-md border border-sand-300 bg-white px-3 text-sm outline-none transition placeholder:text-sand-400 focus:border-navy-500 focus:ring-2 focus:ring-navy-200/60 dark:border-sand-200 dark:bg-sand-50";

const labelClass = "flex flex-col gap-1 text-sm";

const fieldLabelClass = "font-medium text-sand-700 dark:text-sand-600";

async function postJson(
  path: string,
  body: unknown,
): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    return { ok: false, message: json.error?.message ?? `Request failed (${res.status}).` };
  }
  return { ok: true, data: json.data };
}

// --- Add destination ---------------------------------------------------

export function AddDestinationForm({ tripId }: { tripId: string }) {
  const router = useRouter();
  const { busy, message, run } = useAsyncAction();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const arrival = String(data.get("arrival") ?? "");
    const departure = String(data.get("departure") ?? "");

    const result = await run(() =>
      postJson(`/api/trips/${tripId}/destinations`, {
        city: String(data.get("city") ?? "").trim(),
        country: String(data.get("country") ?? "").trim(),
        arrivalDate: arrival ? new Date(arrival).toISOString() : undefined,
        departureDate: departure ? new Date(departure).toISOString() : undefined,
      }),
    );

    if (result?.ok) {
      form.reset();
      router.refresh();
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          <span className={fieldLabelClass}>City</span>
          <input
            name="city"
            type="text"
            required
            maxLength={200}
            placeholder="Lisbon"
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          <span className={fieldLabelClass}>Country</span>
          <input
            name="country"
            type="text"
            required
            maxLength={200}
            placeholder="Portugal"
            className={inputClass}
          />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          <span className={fieldLabelClass}>Arrival date (optional)</span>
          <input name="arrival" type="date" className={inputClass} />
        </label>
        <label className={labelClass}>
          <span className={fieldLabelClass}>Departure date (optional)</span>
          <input name="departure" type="date" className={inputClass} />
        </label>
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? "Adding…" : "Add destination"}
      </Button>
      <FormMessage message={message} />
    </form>
  );
}

// --- Add traveler ------------------------------------------------------

export function AddTravelerForm({ tripId }: { tripId: string }) {
  const router = useRouter();
  const { busy, message, run } = useAsyncAction();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const dob = String(data.get("dob") ?? "");

    const result = await run(() =>
      postJson(`/api/trips/${tripId}/travelers`, {
        fullName: String(data.get("fullName") ?? "").trim(),
        dateOfBirth: dob ? new Date(dob).toISOString() : undefined,
        passportNumber: String(data.get("passport") ?? "").trim() || undefined,
      }),
    );

    if (result?.ok) {
      form.reset();
      router.refresh();
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          <span className={fieldLabelClass}>Full name</span>
          <input name="fullName" type="text" required maxLength={200} className={inputClass} />
        </label>
        <label className={labelClass}>
          <span className={fieldLabelClass}>Date of birth (optional)</span>
          <input name="dob" type="date" className={inputClass} />
        </label>
      </div>
      <label className={labelClass}>
        <span className={fieldLabelClass}>Passport number (optional)</span>
        <input name="passport" type="text" maxLength={50} className={inputClass} />
      </label>
      <Button type="submit" disabled={busy}>
        {busy ? "Adding…" : "Add traveler"}
      </Button>
      <FormMessage message={message} />
    </form>
  );
}

// --- Add flight ---------------------------------------------------------

export function AddFlightForm({ tripId }: { tripId: string }) {
  const router = useRouter();
  const { busy, message, run } = useAsyncAction();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const departure = String(data.get("scheduledDeparture") ?? "");
    const arrival = String(data.get("scheduledArrival") ?? "");

    const result = await run(() =>
      postJson(`/api/trips/${tripId}/flights`, {
        flightNumber: String(data.get("flightNumber") ?? "").trim(),
        airline: String(data.get("airline") ?? "").trim(),
        departureAirport: String(data.get("departureAirport") ?? "")
          .trim()
          .toUpperCase(),
        arrivalAirport: String(data.get("arrivalAirport") ?? "")
          .trim()
          .toUpperCase(),
        scheduledDeparture: departure
          ? new Date(departure).toISOString()
          : new Date().toISOString(),
        scheduledArrival: arrival
          ? new Date(arrival).toISOString()
          : new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      }),
    );

    if (result?.ok) {
      form.reset();
      router.refresh();
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          <span className={fieldLabelClass}>Flight number</span>
          <input
            name="flightNumber"
            type="text"
            required
            maxLength={20}
            placeholder="TP 1353"
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          <span className={fieldLabelClass}>Airline</span>
          <input
            name="airline"
            type="text"
            required
            maxLength={200}
            placeholder="TAP Air Portugal"
            className={inputClass}
          />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          <span className={fieldLabelClass}>Departure airport (IATA)</span>
          <input
            name="departureAirport"
            type="text"
            required
            minLength={3}
            maxLength={3}
            placeholder="LHR"
            className={`${inputClass} uppercase`}
          />
        </label>
        <label className={labelClass}>
          <span className={fieldLabelClass}>Arrival airport (IATA)</span>
          <input
            name="arrivalAirport"
            type="text"
            required
            minLength={3}
            maxLength={3}
            placeholder="LIS"
            className={`${inputClass} uppercase`}
          />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          <span className={fieldLabelClass}>Scheduled departure</span>
          <input name="scheduledDeparture" type="datetime-local" className={inputClass} />
        </label>
        <label className={labelClass}>
          <span className={fieldLabelClass}>Scheduled arrival</span>
          <input name="scheduledArrival" type="datetime-local" className={inputClass} />
        </label>
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? "Adding…" : "Add flight"}
      </Button>
      <FormMessage message={message} />
    </form>
  );
}

// --- Status change --------------------------------------------------------

export function StatusSelect({ tripId, current }: { tripId: string; current: string }) {
  const router = useRouter();
  const { busy, message, run } = useAsyncAction();

  async function handleChange(status: string) {
    const res = await fetch(`/api/trips/${tripId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const json = await res.json();

    await run(async () => {
      if (!res.ok || json.error) {
        throw new Error(json.error?.message ?? "Failed to change status.");
      }
      return json.data as { trip: { id: string } };
    });

    if (!res.ok || json.error) return;
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        defaultValue={current}
        disabled={busy}
        onChange={(e) => handleChange(e.target.value)}
        className="h-9 rounded-md border border-sand-300 bg-white px-3 text-sm font-medium outline-none transition focus:border-navy-500 focus:ring-2 focus:ring-navy-200/60 dark:border-sand-200 dark:bg-sand-50"
      >
        {["PLANNING", "UPCOMING", "ACTIVE", "COMPLETED", "CANCELLED"].map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <FormMessage message={message} />
    </div>
  );
}

// --- Flight status check (Flight Agent) ------------------------------------

export function CheckFlightStatusButton({
  tripId,
  flightId,
}: {
  tripId: string;
  flightId: string;
}) {
  const router = useRouter();
  const { busy, message, run } = useAsyncAction();

  async function handleClick() {
    const result = await run(async () => {
      const res = await fetch(`/api/trips/${tripId}/flights/${flightId}/check-status`, {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok || json.error)
        throw new Error(json.error?.message ?? "Flight status check failed.");
      return json.data as { currentStatus: string; changed: boolean };
    });
    if (result) router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        onClick={handleClick}
        disabled={busy}
        variant="secondary"
        className="h-8 px-3 text-xs"
      >
        {busy ? "Checking…" : "Check status"}
      </Button>
      <FormMessage message={message} />
    </span>
  );
}

// --- Weather check (Weather Agent) ------------------------------------------

export function CheckWeatherButton({
  tripId,
  destinationId,
}: {
  tripId: string;
  destinationId: string;
}) {
  const router = useRouter();
  const { busy, message, run } = useAsyncAction();

  async function handleClick() {
    const result = await run(async () => {
      const res = await fetch(`/api/trips/${tripId}/destinations/${destinationId}/check-weather`, {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error?.message ?? "Weather check failed.");
      return json.data as { significant: boolean };
    });
    if (result) router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        onClick={handleClick}
        disabled={busy}
        variant="secondary"
        className="h-8 px-3 text-xs"
      >
        {busy ? "Checking…" : "Check weather"}
      </Button>
      <FormMessage message={message} />
    </span>
  );
}

// --- Currency check (Currency Agent) -----------------------------------------

export function CurrencyCheckForm({ tripId }: { tripId: string }) {
  const { busy, message, run } = useAsyncAction();
  const [rate, setRate] = useState<{ rate: number; convertedAmount: number | null } | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const amountRaw = String(data.get("amount") ?? "");

    const result = await run(async () => {
      const res = await fetch(`/api/trips/${tripId}/currency-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseCurrency: String(data.get("baseCurrency") ?? "").toUpperCase(),
          targetCurrency: String(data.get("targetCurrency") ?? "").toUpperCase(),
          amount: amountRaw ? Number(amountRaw) : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error?.message ?? "Currency check failed.");
      return json.data as { rate: number; convertedAmount: number | null };
    });

    if (result) setRate(result);
  }

  return (
    <div>
      <form onSubmit={handleSubmit} className="mt-3 grid gap-3 sm:grid-cols-4">
        <label className={labelClass}>
          <span className={fieldLabelClass}>Base</span>
          <input
            name="baseCurrency"
            type="text"
            required
            minLength={3}
            maxLength={3}
            defaultValue="USD"
            className={`${inputClass} uppercase`}
          />
        </label>
        <label className={labelClass}>
          <span className={fieldLabelClass}>Target</span>
          <input
            name="targetCurrency"
            type="text"
            required
            minLength={3}
            maxLength={3}
            defaultValue="EUR"
            className={`${inputClass} uppercase`}
          />
        </label>
        <label className={labelClass}>
          <span className={fieldLabelClass}>Amount (optional)</span>
          <input name="amount" type="number" min={0} step="any" className={inputClass} />
        </label>
        <div className="flex items-end">
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "Checking…" : "Check rate"}
          </Button>
        </div>
      </form>
      {rate && (
        <p className="mt-2 text-sm text-sand-700 dark:text-sand-600">
          Rate: <strong>{rate.rate.toFixed(4)}</strong>
          {rate.convertedAmount !== null && (
            <>
              {" · Converted: "}
              <strong>{rate.convertedAmount.toFixed(2)}</strong>
            </>
          )}
        </p>
      )}
      <FormMessage message={message} />
    </div>
  );
}

// --- Research (Research Agent) -------------------------------------------------

export function ResearchForm({ tripId }: { tripId: string }) {
  const { busy, message, run } = useAsyncAction();
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<{ url: string; title: string }[]>([]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const question = String(data.get("question") ?? "").trim();
    if (!question) return;

    const result = await run(async () => {
      const res = await fetch(`/api/trips/${tripId}/research`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error?.message ?? "Research failed.");
      return json.data as {
        answer: string;
        sources: { url: string; title: string }[];
        hasEvidence: boolean;
      };
    });

    if (result) {
      setAnswer(result.answer);
      setSources(result.sources ?? []);
    }
  }

  return (
    <div>
      <form onSubmit={handleSubmit} className="mt-3 space-y-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className={fieldLabelClass}>Question</span>
          <textarea
            name="question"
            required
            rows={2}
            maxLength={500}
            placeholder="e.g. What's the best area to stay in Lisbon in October?"
            className="w-full resize-y rounded-md border border-sand-300 bg-white px-3 py-2 text-sm outline-none transition placeholder:text-sand-400 focus:border-navy-500 focus:ring-2 focus:ring-navy-200/60 dark:border-sand-200 dark:bg-sand-50"
          />
        </label>
        <Button type="submit" disabled={busy}>
          {busy ? "Researching…" : "Ask"}
        </Button>
      </form>
      {answer && (
        <div className="mt-3 rounded-md border border-sand-200 bg-sand-100/60 p-3 dark:border-sand-200 dark:bg-sand-100/60">
          <p className="text-sm text-sand-800 dark:text-sand-700">{answer}</p>
          {sources.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-sand-500">
              {sources.map((s) => (
                <li key={s.url}>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2"
                  >
                    {s.title || s.url}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <FormMessage message={message} />
    </div>
  );
}

// --- Document upload (Phase 14 pipeline) -----------------------------------
interface UploadedDocument {
  id: string;
  originalFilename: string;
  status: string;
  failureReason: string | null;
  extractedMetadata: {
    extraction?: { pageCount?: number; characterCount?: number; truncated?: boolean };
    flightNumbers?: { value: string }[];
    dates?: { value: string }[];
    bookingReferences?: { value: string }[];
  } | null;
}

/**
 * Multipart upload — deliberately NOT going through postJson(): that
 * helper sets Content-Type: application/json, which would strip the
 * multipart boundary and make the server's formData() parse fail. The
 * browser must set the Content-Type itself, header included.
 */
export function DocumentUploadForm({ tripId }: { tripId: string }) {
  const router = useRouter();
  const { busy, message, run } = useAsyncAction();
  const [uploaded, setUploaded] = useState<UploadedDocument | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = form.elements.namedItem("file") as HTMLInputElement | null;
    if (!file?.files?.[0]) return;

    const body = new FormData();
    body.append("file", file.files[0]);

    const result = await run(async () => {
      const res = await fetch(`/api/trips/${tripId}/documents`, { method: "POST", body });
      const json = await res.json();
      if (!res.ok || json.error) {
        throw new Error(json.error?.message ?? "Document upload failed.");
      }
      return json.data.document as UploadedDocument;
    });

    if (result) {
      setUploaded(result);
      form.reset();
      // Re-render the server component list so the new document (and its
      // extracted status) appears without a manual reload.
      router.refresh();
    }
  }

  const meta = uploaded?.extractedMetadata;
  const extracted =
    uploaded?.status === "READY"
      ? [
          meta?.flightNumbers?.map((f) => f.value).join(", "),
          meta?.bookingReferences?.map((r) => r.value).join(", "),
          meta?.dates?.map((d) => d.value).join(", "),
        ].filter(Boolean)
      : [];

  return (
    <div>
      <form ref={formRef} onSubmit={handleSubmit} className="mt-3 space-y-3">
        <label className={labelClass}>
          <span className={fieldLabelClass}>Document (PDF, JPEG, or PNG — max 10MB)</span>
          <input
            name="file"
            type="file"
            required
            accept="application/pdf,image/jpeg,image/png"
            className="w-full rounded-md border border-sand-300 bg-white px-3 py-2 text-sm outline-none transition file:mr-3 file:rounded file:border-0 file:bg-navy-900 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-white hover:border-navy-500 focus:border-navy-500 focus:ring-2 focus:ring-navy-200/60 dark:border-sand-200 dark:bg-sand-50"
          />
        </label>
        <Button type="submit" disabled={busy}>
          {busy ? "Uploading and extracting…" : "Upload document"}
        </Button>
        <p className="text-xs text-sand-500">
          PDFs are text-extracted on upload. Images are stored but not text-extracted — OCR is not
          implemented, and a document is only marked READY when extraction actually succeeded.
        </p>
      </form>
      <FormMessage message={message} />
      {uploaded && (
        <div
          className={`mt-3 rounded-md border p-3 text-sm ${
            uploaded.status === "READY"
              ? "border-ok-100 bg-ok-100/40 dark:border-ok-500/30"
              : "border-alert-100 bg-alert-100/40 dark:border-alert-500/30"
          }`}
        >
          <p className="font-medium text-navy-950 dark:text-navy-100">
            {uploaded.originalFilename} — {uploaded.status}
          </p>
          {uploaded.status === "READY" && meta?.extraction && (
            <p className="mt-1 text-xs text-sand-600">
              {meta.extraction.pageCount} page{meta.extraction.pageCount === 1 ? "" : "s"} ·{" "}
              {meta.extraction.characterCount?.toLocaleString()} characters extracted
              {meta.extraction.truncated ? " (truncated at the storage cap)" : ""}
            </p>
          )}
          {extracted.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-sand-600">
              {extracted[0] && <li>Flight numbers: {extracted[0]}</li>}
              {extracted[1] && <li>Booking references: {extracted[1]}</li>}
              {extracted[2] && <li>Dates found: {extracted[2]}</li>}
            </ul>
          )}
          {uploaded.status !== "READY" && uploaded.failureReason && (
            <p className="mt-1 text-xs text-alert-600">{uploaded.failureReason}</p>
          )}
        </div>
      )}
    </div>
  );
}

// --- Risk assessment (Phase 16) -----------------------------------------
interface RiskFactor {
  key: string;
  label: string;
  weight: number;
  points: number;
  dataAvailable: boolean;
  detail: string;
}

interface RiskResponse {
  assessment: {
    id: string;
    riskScore: number;
    severity: string;
    confidence: number;
  };
  factors: RiskFactor[];
  dataGaps: number;
}

/**
 * Shows the score and, critically, WHY: each factor's own points out of
 * its own weight, plus the real values behind it. A factor with no data
 * is labelled as unscored rather than quietly presented as zero risk.
 */
export function AssessRiskButton({ tripId }: { tripId: string }) {
  const router = useRouter();
  const { busy, message, run } = useAsyncAction();
  const [result, setResult] = useState<RiskResponse | null>(null);

  async function handleClick() {
    const response = await run(async () => {
      const res = await fetch(`/api/trips/${tripId}/risk`, { method: "POST" });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error?.message ?? "Risk assessment failed.");
      return json.data as RiskResponse;
    });
    if (response) {
      setResult(response);
      router.refresh();
    }
  }

  return (
    <div>
      <Button onClick={handleClick} disabled={busy} variant="secondary">
        {busy ? "Assessing…" : "Assess risk now"}
      </Button>
      <FormMessage message={message} />
      {result && (
        <div className="mt-3 rounded-md border border-sand-200 p-3 dark:border-sand-200">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-medium text-navy-950 dark:text-navy-100">
              Risk score {result.assessment.riskScore}/100 · {result.assessment.severity}
            </p>
            <p className="text-xs text-sand-500">
              confidence {(result.assessment.confidence * 100).toFixed(0)}% of factors had data
            </p>
          </div>
          <ul className="mt-2 space-y-1.5">
            {result.factors.map((factor) => (
              <li key={factor.key} className="text-xs">
                <span className="font-medium text-sand-700 dark:text-sand-600">
                  {factor.label}: {factor.points}/{factor.weight}
                </span>
                {!factor.dataAvailable && (
                  <span className="ml-1 text-warn-700 dark:text-warn-500">
                    (not scored — no data)
                  </span>
                )}
                <span className="block text-sand-500">{factor.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

interface SearchHit {
  documentId: string;
  originalFilename: string;
  chunkIndex: number;
  content: string;
  similarity: number;
}

interface SearchResponse {
  chunks: SearchHit[];
  noEvidence: boolean;
  embeddingProvider: string;
  semantic: boolean;
}

/**
 * Renders retrieved chunks exactly as ranked, including the similarity
 * that put each one there, and names the embedding provider. When the
 * provider is the local fallback, that fact is stated in the UI rather
 * than left for the user to assume.
 */
export function DocumentSearchForm({ tripId }: { tripId: string }) {
  const { busy, message, run } = useAsyncAction();
  const [result, setResult] = useState<SearchResponse | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const query = String(data.get("query") ?? "").trim();
    if (!query) return;

    const response = await run(async () => {
      const res = await fetch(`/api/trips/${tripId}/documents/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error?.message ?? "Search failed.");
      return json.data as SearchResponse;
    });

    if (response) setResult(response);
  }

  return (
    <div>
      <form onSubmit={handleSubmit} className="mt-3 flex flex-wrap items-end gap-3">
        <label className={`${labelClass} min-w-0 flex-1`}>
          <span className={fieldLabelClass}>Ask your documents</span>
          <input
            name="query"
            type="text"
            required
            maxLength={500}
            placeholder="e.g. what time does my flight leave?"
            className={inputClass}
          />
        </label>
        <Button type="submit" disabled={busy}>
          {busy ? "Searching…" : "Search"}
        </Button>
      </form>
      <FormMessage message={message} />
      {result && (
        <div className="mt-3">
          <p className="text-xs text-sand-500">
            {result.noEvidence
              ? "No indexed document content matched this query."
              : `${result.chunks.length} chunk${result.chunks.length === 1 ? "" : "s"} matched, ranked by cosine similarity.`}
          </p>
          {!result.semantic && (
            <p className="mt-1 text-xs text-warn-700 dark:text-warn-500">
              Ranked with the local <code>{result.embeddingProvider}</code> fallback — lexical
              similarity, not semantic. Add a VOYAGE_API_KEY for real embeddings.
            </p>
          )}
          {result.chunks.length > 0 && (
            <ul className="mt-2 space-y-2">
              {result.chunks.map((hit) => (
                <li
                  key={`${hit.documentId}-${hit.chunkIndex}`}
                  className="rounded-lg border border-sand-200 p-3 dark:border-sand-200"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-xs font-medium text-navy-950 dark:text-navy-100">
                      {hit.originalFilename} · chunk {hit.chunkIndex + 1}
                    </span>
                    <span className="flex-none text-xs text-sand-500">
                      similarity {(hit.similarity * 100).toFixed(1)}%
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-line text-sm text-sand-800 dark:text-sand-700">
                    {hit.content}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
