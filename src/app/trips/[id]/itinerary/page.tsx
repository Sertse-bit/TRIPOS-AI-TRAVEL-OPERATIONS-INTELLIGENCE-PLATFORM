import Link from "next/link";
import { requireSession } from "@/app/require-auth";
import { orNotFound } from "@/app/not-found-guard";
import { getTripDigitalTwin } from "@/modules/trip/trip-service";
import { listTripItinerary } from "@/modules/itinerary/itinerary-service";
import { providerAvailability } from "@/config/env";
import { Card, EmptyState, SectionHeading } from "@/components/ui";
import {
  AddItineraryItemForm,
  BudgetForm,
  DeleteItineraryItemButton,
  GeneratePlanButton,
} from "./itinerary-actions";

/**
 * Itinerary & budget (Phase 20). A server component: it reads the real
 * stored items and the deterministic budget status, renders them, and
 * hands interactions to the client islands below it. Nothing here is
 * computed by a model.
 */

function fmtDay(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    // An unrecognized currency code must not crash the page.
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Every calendar day in the trip's range, or [] when no dates are set. */
function tripDays(startDate: Date | null, endDate: Date | null): string[] {
  if (!startDate || !endDate) return [];
  const days: string[] = [];
  const cursor = new Date(startDate.toISOString().slice(0, 10) + "T00:00:00Z");
  const last = endDate.toISOString().slice(0, 10);
  while (cursor.toISOString().slice(0, 10) <= last) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function itemTypeLabel(type: string): string {
  return type.charAt(0) + type.slice(1).toLowerCase();
}

export default async function ItineraryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession(`/trips/${id}/itinerary`);

  // Same 404 semantics as the trip page and the API (see not-found-guard.ts).
  const twin = await orNotFound(() => getTripDigitalTwin(id, user.id));
  const { items, budget } = await orNotFound(() => listTripItinerary(id, user.id));
  const { trip, destinations } = twin;

  const days = tripDays(trip.startDate, trip.endDate);
  const itemsByDay = new Map<string, typeof items>();
  for (const item of items) {
    const list = itemsByDay.get(item.itineraryDay) ?? [];
    list.push(item);
    itemsByDay.set(item.itineraryDay, list);
  }

  // With trip dates: show every day, so a gap is visible as a gap. Without
  // them: show only the days that actually have items.
  const visibleDays =
    days.length > 0 ? days : [...itemsByDay.keys()].sort((a, b) => a.localeCompare(b));

  return (
    <div>
      <Link
        href={`/trips/${id}`}
        className="text-sm text-sand-600 underline-offset-2 hover:underline"
      >
        ← Back to trip
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-navy-950 dark:text-sand-800">
        Itinerary &amp; budget
      </h1>
      <p className="mt-1 text-sm text-sand-600">
        {trip.title}
        {days.length > 0
          ? ` · ${fmtDay(days[0])} – ${fmtDay(days[days.length - 1])}`
          : " · No dates set"}
      </p>

      {!providerAvailability.anthropic && (
        <p className="mt-3 rounded-lg border border-warn-100 bg-warn-100/40 p-3 text-sm text-warn-700">
          The AI planner is unavailable because no Anthropic API key is configured — it will not
          invent a plan without a model. Manual items and budget validation below work fully.
        </p>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Timeline */}
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <SectionHeading>Day-by-day plan</SectionHeading>
            {items.length === 0 && visibleDays.length === 0 ? (
              <EmptyState>
                <span className="mt-2 block">
                  Nothing scheduled yet. Add your first item below, or generate a plan.
                </span>
              </EmptyState>
            ) : (
              <div className="mt-4 space-y-5">
                {visibleDays.map((day, index) => {
                  const dayItems = itemsByDay.get(day) ?? [];
                  return (
                    <div key={day}>
                      <p className="text-xs font-semibold uppercase tracking-wide text-navy-700 dark:text-navy-500">
                        {days.length > 0 ? `Day ${index + 1} · ` : ""}
                        {fmtDay(day)}
                      </p>
                      {dayItems.length === 0 ? (
                        <p className="mt-1.5 text-xs text-sand-600">Nothing scheduled.</p>
                      ) : (
                        <ul className="mt-2 space-y-2">
                          {dayItems.map((item) => (
                            <li
                              key={item.id}
                              className="rounded-lg border border-sand-200 p-3 dark:border-sand-200"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="font-medium text-navy-950 dark:text-sand-800">
                                    {item.title}
                                    {item.source === "AI_PLANNER" && (
                                      <span className="ml-2 rounded-full bg-navy-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-navy-600 dark:text-navy-500">
                                        AI
                                      </span>
                                    )}
                                  </p>
                                  <p className="mt-0.5 text-xs text-sand-600">
                                    {item.startTime
                                      ? `${item.startTime}${item.endTime ? `–${item.endTime}` : ""} · `
                                      : ""}
                                    {itemTypeLabel(item.itemType)}
                                    {item.location ? ` · ${item.location}` : ""}
                                    {item.estimatedCost !== null && item.currency
                                      ? ` · ${formatMoney(item.estimatedCost, item.currency)}`
                                      : " · no recorded cost"}
                                  </p>
                                  {item.notes && (
                                    <p className="mt-1 text-xs text-sand-600">{item.notes}</p>
                                  )}
                                </div>
                                <DeleteItineraryItemButton tripId={id} itemId={item.id} />
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card>
            <SectionHeading>Add an item</SectionHeading>
            {days.length === 0 && (
              <p className="mt-1.5 text-sm text-sand-600">
                This trip has no dates yet. You can still add items by date; set the trip&apos;s
                dates to enable the AI planner and date-range validation.
              </p>
            )}
            <AddItineraryItemForm
              tripId={id}
              days={days}
              destinations={destinations.map((d) => ({ id: d.id, city: d.city }))}
            />
          </Card>
        </div>

        {/* Budget + planner */}
        <div className="space-y-6">
          <Card>
            <SectionHeading>Budget</SectionHeading>

            {budget.configured ? (
              <div className="mt-3 space-y-2">
                <p className="text-sm text-navy-950 dark:text-sand-800">
                  Cap{" "}
                  <strong>{formatMoney(budget.limit as number, budget.currency as string)}</strong>
                </p>

                {budget.converted ? (
                  <p className="text-sm text-navy-950 dark:text-sand-800">
                    Recorded costs total{" "}
                    <strong>
                      {formatMoney(budget.converted.total, budget.converted.currency)}
                    </strong>{" "}
                    ·{" "}
                    {budget.converted.overBudget ? (
                      <span className="font-semibold text-alert-600">
                        {formatMoney(
                          Math.abs(budget.converted.remaining),
                          budget.currency as string,
                        )}{" "}
                        over budget
                      </span>
                    ) : (
                      <span className="font-semibold text-ok-600">
                        {formatMoney(budget.converted.remaining, budget.currency as string)}{" "}
                        remaining
                      </span>
                    )}
                  </p>
                ) : (
                  <p className="text-sm text-warn-700">
                    Costs couldn&apos;t be converted to {budget.currency}: {budget.conversionError}
                  </p>
                )}

                {budget.converted && budget.converted.lines.some((line) => line.rateAsOf) && (
                  <ul className="text-xs text-sand-600">
                    {budget.converted.lines
                      .filter((line) => line.rateAsOf)
                      .map((line) => (
                        <li key={line.itemId}>
                          {line.currency} → {budget.converted?.currency} at {line.exchangeRate} (
                          {line.rateAsOf})
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            ) : (
              <p className="mt-2 text-sm text-sand-600">
                No budget cap set. Costs are still recorded and totalled per currency below; a cap
                adds the converted total and over/under check.
              </p>
            )}

            {budget.totalsByCurrency.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-sand-600">
                  Recorded costs by currency
                </p>
                <ul className="mt-1 space-y-0.5 text-sm text-navy-950 dark:text-sand-800">
                  {budget.totalsByCurrency.map((total) => (
                    <li key={total.currency}>
                      {formatMoney(total.amount, total.currency)}
                      <span className="text-xs text-sand-600">
                        {" "}
                        · {total.itemCount} item{total.itemCount === 1 ? "" : "s"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {budget.itemsWithoutCost > 0 && (
              <p className="mt-2 text-xs text-sand-600">
                {budget.itemsWithoutCost} item{budget.itemsWithoutCost === 1 ? " has" : "s have"} no
                recorded cost and {budget.itemsWithoutCost === 1 ? "is" : "are"} excluded from these
                totals — unknown costs are never assumed to be zero.
              </p>
            )}

            <BudgetForm
              tripId={id}
              currentAmount={trip.budgetAmount}
              currentCurrency={trip.budgetCurrency}
            />
          </Card>

          <Card>
            <SectionHeading>AI itinerary planner</SectionHeading>
            <p className="mt-1.5 text-sm text-sand-600">
              Composes a day-by-day schedule from this trip&apos;s real dates, destinations,
              weather, search results, and uploaded documents. It proposes the schedule only: every
              date and city is checked against the trip before saving, it never estimates a price,
              and it replaces its own previous items without touching the ones you added.
            </p>
            {providerAvailability.anthropic ? (
              <GeneratePlanButton tripId={id} />
            ) : (
              <p className="mt-3 text-sm text-warn-700">
                Set an ANTHROPIC_API_KEY to enable this. Until then the endpoint returns a clear 502
                rather than a fabricated plan.
              </p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
