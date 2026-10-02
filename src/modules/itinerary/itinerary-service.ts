import {
  getTrip,
  getTripDestinations,
  emitTripEvent,
  updateTripBudget,
} from "@/modules/trip/trip-service";
import { NotFoundError, ValidationError } from "@/shared/errors";
import {
  type ItineraryItemRecord,
  type ItineraryItemType,
  type UpdateItineraryItemInput,
  deleteItineraryItem as deleteItineraryItemRow,
  findItineraryItemById,
  findItineraryItemsByTripId,
  insertItineraryItem,
  replaceAiPlanItems,
  updateItineraryItem as updateItineraryItemRow,
} from "./itinerary-repository";
import { computeItineraryBudgetStatus, type ItineraryBudgetStatus } from "./budget-service";

/**
 * Itinerary Service — Phase 20 (AI Itinerary Planner).
 *
 * The public interface of the itinerary module. Every other module and
 * the HTTP layer reach it through these functions; the repository above
 * is internal to this module, per the project's module boundary rule.
 *
 * Two writers exist, and the difference matters:
 *
 *  - The traveler adds, edits, and deletes items directly. These rows are
 *    `source: "USER"` and are never touched by a regenerated plan.
 *  - The planning agent produces a schedule through the orchestrator, and
 *    its validated output is persisted as `source: "AI_PLANNER"` rows by
 *    `replaceGeneratedPlan`. A re-run replaces exactly those rows.
 *
 * Neither writer goes through the other's path, so regenerating a plan
 * can't destroy the traveler's own entries, and a manual edit can't be
 * silently overwritten by a later run.
 */

/**
 * Converts a stored timestamptz into the calendar day ('YYYY-MM-DD') the
 * traveler entered it as. The UI sends `new Date("2026-10-03")`, i.e.
 * midnight UTC, so reading the UTC date back is the inverse operation.
 */
export function calendarDayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Bounds an item's day to the trip's dates when the trip has them.
 * Deliberately lenient when it doesn't: a traveler sketching items before
 * dates are settled is legitimate, and there is no stored range to
 * contradict. The planner, by contrast, requires dates (see the agent) —
 * a generated day-by-day schedule with no date range to ground it would
 * be inventing its own calendar.
 */
async function assertDayWithinTrip(tripId: string, userId: string, day: string): Promise<void> {
  const trip = await getTrip(tripId, userId);
  if (trip.startDate && day < calendarDayOf(trip.startDate)) {
    throw new ValidationError(
      `The trip starts on ${calendarDayOf(trip.startDate)}; ${day} is before it.`,
    );
  }
  if (trip.endDate && day > calendarDayOf(trip.endDate)) {
    throw new ValidationError(
      `The trip ends on ${calendarDayOf(trip.endDate)}; ${day} is after it.`,
    );
  }
}

async function assertDestinationBelongsToTrip(
  tripId: string,
  userId: string,
  destinationId: string,
): Promise<void> {
  const destinations = await getTripDestinations(tripId, userId);
  if (!destinations.some((destination) => destination.id === destinationId)) {
    throw new ValidationError("That destination does not belong to this trip.");
  }
}

function assertTimeOrder(startTime?: string | null, endTime?: string | null): void {
  if (startTime && endTime && endTime < startTime) {
    throw new ValidationError(`The end time (${endTime}) is before the start time (${startTime}).`);
  }
}

async function requireOwnedItem(
  tripId: string,
  itemId: string,
  userId: string,
): Promise<ItineraryItemRecord> {
  await getTrip(tripId, userId);
  const item = await findItineraryItemById(itemId);
  if (!item || item.tripId !== tripId) {
    throw new NotFoundError("Itinerary item", itemId);
  }
  return item;
}

export interface TripItinerary {
  items: ItineraryItemRecord[];
  budget: ItineraryBudgetStatus;
}

export async function listTripItinerary(tripId: string, userId: string): Promise<TripItinerary> {
  const trip = await getTrip(tripId, userId);
  const items = await findItineraryItemsByTripId(tripId);
  const budget = await computeItineraryBudgetStatus(trip, items);
  return { items, budget };
}

export interface AddItineraryItemParams {
  day: string;
  title: string;
  itemType?: ItineraryItemType;
  startTime?: string;
  endTime?: string;
  location?: string;
  destinationId?: string;
  notes?: string;
  estimatedCost?: number;
  currency?: string;
}

export async function addItineraryItem(
  tripId: string,
  userId: string,
  input: AddItineraryItemParams,
): Promise<ItineraryItemRecord> {
  await assertDayWithinTrip(tripId, userId, input.day);
  assertTimeOrder(input.startTime, input.endTime);
  if (input.destinationId) {
    await assertDestinationBelongsToTrip(tripId, userId, input.destinationId);
  }

  const item = await insertItineraryItem({
    tripId,
    itineraryDay: input.day,
    startTime: input.startTime ?? null,
    endTime: input.endTime ?? null,
    title: input.title,
    itemType: input.itemType ?? "OTHER",
    location: input.location ?? null,
    destinationId: input.destinationId ?? null,
    notes: input.notes ?? null,
    estimatedCost: input.estimatedCost ?? null,
    currency: input.currency ?? null,
    source: "USER",
  });

  await emitTripEvent(tripId, userId, {
    eventType: "ITINERARY_ITEM_ADDED",
    entityType: "itinerary_item",
    entityId: item.id,
    metadata: { title: item.title, day: item.itineraryDay, itemType: item.itemType },
  });

  return item;
}

export async function updateItineraryItem(
  tripId: string,
  itemId: string,
  userId: string,
  updates: UpdateItineraryItemInput & { day?: string },
): Promise<ItineraryItemRecord> {
  const existing = await requireOwnedItem(tripId, itemId, userId);

  if (updates.day !== undefined) {
    await assertDayWithinTrip(tripId, userId, updates.day);
  }

  const nextStart = updates.startTime === undefined ? existing.startTime : updates.startTime;
  const nextEnd = updates.endTime === undefined ? existing.endTime : updates.endTime;
  assertTimeOrder(nextStart, nextEnd);

  if (updates.destinationId) {
    await assertDestinationBelongsToTrip(tripId, userId, updates.destinationId);
  }

  const { day, ...repoUpdates } = updates;
  const updated = await updateItineraryItemRow(itemId, {
    ...repoUpdates,
    itineraryDay: day,
  });
  if (!updated) throw new NotFoundError("Itinerary item", itemId);

  await emitTripEvent(tripId, userId, {
    eventType: "ITINERARY_ITEM_UPDATED",
    entityType: "itinerary_item",
    entityId: updated.id,
    metadata: { title: updated.title, day: updated.itineraryDay },
  });

  return updated;
}

export async function deleteItineraryItem(
  tripId: string,
  itemId: string,
  userId: string,
): Promise<void> {
  const existing = await requireOwnedItem(tripId, itemId, userId);
  const removed = await deleteItineraryItemRow(itemId);
  if (!removed) throw new NotFoundError("Itinerary item", itemId);

  await emitTripEvent(tripId, userId, {
    eventType: "ITINERARY_ITEM_REMOVED",
    entityType: "itinerary_item",
    entityId: itemId,
    metadata: { title: existing.title, day: existing.itineraryDay },
  });
}

/**
 * Sets the trip's budget cap, or clears it when passed null. Returns the
 * recomputed budget status so the caller never has to re-derive it.
 */
export async function setTripBudget(
  tripId: string,
  userId: string,
  budget: { amount: number; currency: string } | null,
): Promise<ItineraryBudgetStatus> {
  const updated = await updateTripBudget(tripId, userId, budget);

  await emitTripEvent(tripId, userId, {
    eventType: "TRIP_BUDGET_UPDATED",
    entityType: "trip",
    entityId: tripId,
    metadata: budget
      ? { budgetAmount: budget.amount, budgetCurrency: budget.currency }
      : { budgetAmount: null, budgetCurrency: null, cleared: true },
  });

  const items = await findItineraryItemsByTripId(tripId);
  return computeItineraryBudgetStatus(updated, items);
}

/** A validated item the planning agent produced, ready to persist. */
export interface PlanItemDraft {
  itineraryDay: string;
  startTime: string | null;
  endTime: string | null;
  title: string;
  itemType: ItineraryItemType;
  location: string | null;
  destinationId: string | null;
  notes: string | null;
}

/**
 * Persists one planning run's output, replacing the trip's previous
 * AI_PLANNER rows (atomically, in the repository). USER rows survive —
 * regenerating a plan must not delete what the traveler typed in.
 */
export async function replaceGeneratedPlan(
  tripId: string,
  userId: string,
  planRunId: string,
  drafts: PlanItemDraft[],
): Promise<{ items: ItineraryItemRecord[]; replacedCount: number; budget: ItineraryBudgetStatus }> {
  const trip = await getTrip(tripId, userId);

  const { items, replacedCount } = await replaceAiPlanItems(tripId, planRunId, drafts);

  await emitTripEvent(tripId, userId, {
    eventType: "ITINERARY_PLANNED",
    entityType: "itinerary_item",
    entityId: planRunId,
    metadata: {
      planRunId,
      itemsCreated: items.length,
      aiItemsReplaced: replacedCount,
      days: new Set(drafts.map((draft) => draft.itineraryDay)).size,
    },
  });

  // Budget is computed over the full item list, not just the new drafts:
  // a plan's true cost position includes the traveler's own items too.
  const allItems = await findItineraryItemsByTripId(tripId);
  const budget = await computeItineraryBudgetStatus(trip, allItems);

  return { items, replacedCount, budget };
}
