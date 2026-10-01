"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
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
