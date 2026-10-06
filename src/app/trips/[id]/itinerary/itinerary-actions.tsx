"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, FormMessage, useAsyncAction } from "@/components/ui";

/* ------------------------------------------------------------------ */
/* Client islands for the itinerary page (Phase 20). Each posts to the */
/* real API routes and refreshes the server component tree on success  */
/* so the page re-renders from the database.                           */
/* ------------------------------------------------------------------ */

const inputClass =
  "h-10 w-full rounded-md border border-sand-300 bg-white px-3 text-sm outline-none transition placeholder:text-sand-600 focus:border-navy-500 focus:ring-2 focus:ring-navy-200/60 dark:border-sand-200 dark:bg-sand-50";

const fieldLabelClass = "flex flex-col gap-1 text-sm font-medium text-sand-700 dark:text-sand-600";

const ITEM_TYPES = ["FLIGHT", "LODGING", "ACTIVITY", "TRANSPORT", "MEAL", "OTHER"] as const;

async function request(
  path: string,
  method: string,
  body?: unknown,
): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    return { ok: false, message: json.error?.message ?? `Request failed (${res.status}).` };
  }
  return { ok: true, data: json.data };
}

// --- Add item ----------------------------------------------------------

export function AddItineraryItemForm({
  tripId,
  days,
  destinations,
}: {
  tripId: string;
  /** Trip days as 'YYYY-MM-DD' (empty when the trip has no dates yet). */
  days: string[];
  destinations: Array<{ id: string; city: string }>;
}) {
  const router = useRouter();
  const { busy, message, run } = useAsyncAction();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);

    const cost = String(data.get("estimatedCost") ?? "").trim();
    const currency = String(data.get("currency") ?? "")
      .trim()
      .toUpperCase();
    const destinationId = String(data.get("destinationId") ?? "");

    const result = await run(() =>
      request(`/api/trips/${tripId}/itinerary`, "POST", {
        day: String(data.get("day") ?? ""),
        title: String(data.get("title") ?? "").trim(),
        itemType: String(data.get("itemType") ?? "OTHER"),
        startTime: String(data.get("startTime") ?? "").trim() || undefined,
        endTime: String(data.get("endTime") ?? "").trim() || undefined,
        destinationId: destinationId || undefined,
        location: String(data.get("location") ?? "").trim() || undefined,
        notes: String(data.get("notes") ?? "").trim() || undefined,
        // Cost and currency travel together or not at all — the API and
        // the database both enforce that, so send both or neither.
        estimatedCost: cost ? Number(cost) : undefined,
        currency: cost && currency ? currency : undefined,
      }),
    );

    if (result?.ok) {
      form.reset();
      router.refresh();
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 grid gap-3 sm:grid-cols-2">
      {days.length > 0 ? (
        <label className={fieldLabelClass}>
          Day
          <select name="day" required defaultValue={days[0]} className={inputClass}>
            {days.map((day, index) => (
              <option key={day} value={day}>
                Day {index + 1} · {day}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className={fieldLabelClass}>
          Day
          <input type="date" name="day" required className={inputClass} />
        </label>
      )}

      <label className={fieldLabelClass}>
        Type
        <select name="itemType" defaultValue="ACTIVITY" className={inputClass}>
          {ITEM_TYPES.map((type) => (
            <option key={type} value={type}>
              {type.charAt(0) + type.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
      </label>

      <label className={`${fieldLabelClass} sm:col-span-2`}>
        Title
        <input
          name="title"
          required
          maxLength={200}
          placeholder="e.g. Museum visit"
          className={inputClass}
        />
      </label>

      <label className={fieldLabelClass}>
        Start time
        <input type="time" name="startTime" className={inputClass} />
      </label>
      <label className={fieldLabelClass}>
        End time
        <input type="time" name="endTime" className={inputClass} />
      </label>

      {destinations.length > 0 && (
        <label className={fieldLabelClass}>
          Destination
          <select name="destinationId" defaultValue="" className={inputClass}>
            <option value="">Not tied to a destination</option>
            {destinations.map((destination) => (
              <option key={destination.id} value={destination.id}>
                {destination.city}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className={fieldLabelClass}>
        Location
        <input
          name="location"
          maxLength={300}
          placeholder="Optional, e.g. National Museum"
          className={inputClass}
        />
      </label>

      <label className={fieldLabelClass}>
        Cost
        <input
          type="number"
          name="estimatedCost"
          min="0"
          step="0.01"
          placeholder="Optional"
          className={inputClass}
        />
      </label>
      <label className={fieldLabelClass}>
        Currency
        <input name="currency" maxLength={3} placeholder="e.g. USD" className={inputClass} />
      </label>

      <label className={`${fieldLabelClass} sm:col-span-2`}>
        Notes
        <input name="notes" maxLength={2000} placeholder="Optional" className={inputClass} />
      </label>

      <div className="sm:col-span-2">
        <Button type="submit" busy={busy}>
          {busy ? "Adding…" : "Add item"}
        </Button>
        <div className="mt-2">
          <FormMessage message={message} />
        </div>
        <p className="mt-1 text-xs text-sand-600">
          Costs are yours to record — the AI planner never estimates a price. Leave both cost fields
          empty if you don&apos;t know one; the budget totals will show how many items have no
          recorded cost.
        </p>
      </div>
    </form>
  );
}

// --- Delete item -------------------------------------------------------

export function DeleteItineraryItemButton({ tripId, itemId }: { tripId: string; itemId: string }) {
  const router = useRouter();
  const { busy, run } = useAsyncAction();

  async function handleDelete() {
    const result = await run(() => request(`/api/trips/${tripId}/itinerary/${itemId}`, "DELETE"));
    if (result?.ok) router.refresh();
  }

  return (
    <Button variant="ghost" onClick={handleDelete} busy={busy} className="h-7 px-2 text-xs">
      {busy ? "Removing…" : "Remove"}
    </Button>
  );
}

// --- Budget ------------------------------------------------------------

export function BudgetForm({
  tripId,
  currentAmount,
  currentCurrency,
}: {
  tripId: string;
  currentAmount: number | null;
  currentCurrency: string | null;
}) {
  const router = useRouter();
  const { busy, message, run } = useAsyncAction();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);

    const result = await run(() =>
      request(`/api/trips/${tripId}/budget`, "PUT", {
        amount: Number(String(data.get("amount") ?? "")),
        currency: String(data.get("currency") ?? "")
          .trim()
          .toUpperCase(),
      }),
    );

    if (result?.ok) router.refresh();
  }

  async function handleClear() {
    const result = await run(() => request(`/api/trips/${tripId}/budget`, "DELETE"));
    if (result?.ok) router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 flex flex-wrap items-end gap-3">
      <label className="flex w-36 flex-col gap-1 text-sm font-medium text-sand-700 dark:text-sand-600">
        Budget cap
        <input
          type="number"
          name="amount"
          min="0.01"
          step="0.01"
          required
          defaultValue={currentAmount ?? ""}
          placeholder="e.g. 2500"
          className={inputClass}
        />
      </label>
      <label className="flex w-24 flex-col gap-1 text-sm font-medium text-sand-700 dark:text-sand-600">
        Currency
        <input
          name="currency"
          maxLength={3}
          required
          defaultValue={currentCurrency ?? ""}
          placeholder="USD"
          className={inputClass}
        />
      </label>
      <Button type="submit" busy={busy} variant="secondary">
        {busy ? "Saving…" : currentAmount !== null ? "Update budget" : "Set budget"}
      </Button>
      {currentAmount !== null && (
        <Button variant="ghost" onClick={handleClear} busy={busy}>
          Clear
        </Button>
      )}
      <div className="w-full">
        <FormMessage message={message} />
      </div>
    </form>
  );
}

// --- AI plan -----------------------------------------------------------

interface PlanResponse {
  itemsCreated: number;
  aiItemsReplaced: number;
  rationale: string;
  assumptions: string[];
  budget: { converted: { overBudget: boolean } | null };
}

export function GeneratePlanButton({ tripId }: { tripId: string }) {
  const router = useRouter();
  const { busy, message, setMessage, run } = useAsyncAction();
  const [plan, setPlan] = useState<PlanResponse | null>(null);

  async function handleGenerate() {
    setPlan(null);
    const result = await run(async () => {
      const response = await request(`/api/trips/${tripId}/itinerary/plan`, "POST");
      if (!response.ok) throw new Error(response.message);
      return response.data as PlanResponse;
    });

    if (result) {
      setPlan(result);
      setMessage({
        type: "success",
        text:
          `Plan generated: ${result.itemsCreated} item${result.itemsCreated === 1 ? "" : "s"}` +
          (result.aiItemsReplaced > 0
            ? `, replacing ${result.aiItemsReplaced} previously generated item${result.aiItemsReplaced === 1 ? "" : "s"}`
            : "") +
          ". Your own items were left untouched.",
      });
      router.refresh();
    }
  }

  return (
    <div className="mt-3">
      <Button onClick={handleGenerate} busy={busy}>
        {busy ? "Planning… (up to 30s)" : "Generate a plan with AI"}
      </Button>
      <div className="mt-2">
        <FormMessage message={message} />
      </div>

      {plan && (
        <div className="mt-3 space-y-2 rounded-lg border border-sand-200 p-3 dark:border-sand-200">
          <p className="text-sm text-navy-950 dark:text-sand-800">{plan.rationale}</p>
          {plan.budget.converted?.overBudget && (
            <p className="text-sm text-alert-600">
              This plan sits over the budget cap once your recorded costs are counted.
            </p>
          )}
          {plan.assumptions.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-sand-600">
                Assumptions the planner made
              </p>
              <ul className="mt-1 list-inside list-disc text-xs text-sand-600">
                {plan.assumptions.map((assumption) => (
                  <li key={assumption}>{assumption}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
