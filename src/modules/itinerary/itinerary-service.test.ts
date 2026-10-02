import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/infrastructure/db";
import { createTrip, getTripEventHistory } from "@/modules/trip/trip-service";
import { NotFoundError, ProviderError, ValidationError } from "@/shared/errors";

/**
 * The currency provider is the one external dependency in this module's
 * path, so it is mocked at the module boundary — the same approach the
 * monitor tests use for provider pinning. Everything else here (Postgres,
 * ownership checks, enum casts, the budget arithmetic) is genuinely real.
 */
const { mockGetExchangeRate } = vi.hoisted(() => ({ mockGetExchangeRate: vi.fn() }));

vi.mock("@/integrations/currency/provider", () => ({
  getCurrencyProvider: () => ({ getExchangeRate: mockGetExchangeRate }),
}));

import {
  addItineraryItem,
  calendarDayOf,
  deleteItineraryItem,
  listTripItinerary,
  replaceGeneratedPlan,
  setTripBudget,
  updateItineraryItem,
  type PlanItemDraft,
} from "@/modules/itinerary/itinerary-service";

const OWNER_EMAIL = "itinerary-owner@example.com";
const OTHER_EMAIL = "itinerary-other@example.com";
let ownerId: string;
let otherId: string;

async function createTestUser(email: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'Test') RETURNING id`,
    [email],
  );
  return result.rows[0].id;
}

async function cleanupTestUsers(): Promise<void> {
  await pool.query(`DELETE FROM users WHERE email IN ($1, $2)`, [OWNER_EMAIL, OTHER_EMAIL]);
}

beforeEach(async () => {
  await cleanupTestUsers();
  mockGetExchangeRate.mockReset();
  ownerId = await createTestUser(OWNER_EMAIL);
  otherId = await createTestUser(OTHER_EMAIL);
});

afterEach(async () => {
  await cleanupTestUsers();
});

async function tripWithDates(userId = ownerId) {
  return createTrip(userId, {
    title: "Itinerary trip",
    startDate: new Date("2026-10-03T00:00:00Z"),
    endDate: new Date("2026-10-05T00:00:00Z"),
  });
}

describe("calendarDayOf", () => {
  it("reads a stored midnight-UTC trip date back as the day the traveler entered", () => {
    expect(calendarDayOf(new Date("2026-10-03T00:00:00Z"))).toBe("2026-10-03");
  });
});

describe("addItineraryItem", () => {
  it("persists an item and returns it exactly as stored", async () => {
    const trip = await tripWithDates();

    const item = await addItineraryItem(trip.id, ownerId, {
      day: "2026-10-03",
      title: "Arrival",
      itemType: "FLIGHT",
      startTime: "09:00",
      endTime: "10:30",
      location: "Bole International Airport",
      estimatedCost: 120.5,
      currency: "USD",
    });

    expect(item.itineraryDay).toBe("2026-10-03");
    expect(item.startTime).toBe("09:00");
    expect(item.estimatedCost).toBe(120.5);
    expect(item.currency).toBe("USD");
    expect(item.source).toBe("USER");

    const { items } = await listTripItinerary(trip.id, ownerId);
    expect(items.map((row) => row.id)).toContain(item.id);
  });

  it("records an ITINERARY_ITEM_ADDED event", async () => {
    const trip = await tripWithDates();
    await addItineraryItem(trip.id, ownerId, { day: "2026-10-04", title: "Museum" });

    const events = await getTripEventHistory(trip.id, ownerId);
    expect(events.some((event) => event.eventType === "ITINERARY_ITEM_ADDED")).toBe(true);
  });

  it("rejects a day before the trip starts", async () => {
    const trip = await tripWithDates();
    await expect(
      addItineraryItem(trip.id, ownerId, { day: "2026-10-02", title: "Too early" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a day after the trip ends", async () => {
    const trip = await tripWithDates();
    await expect(
      addItineraryItem(trip.id, ownerId, { day: "2026-10-06", title: "Too late" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects an end time before the start time", async () => {
    const trip = await tripWithDates();
    await expect(
      addItineraryItem(trip.id, ownerId, {
        day: "2026-10-03",
        title: "Backwards",
        startTime: "14:00",
        endTime: "13:00",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a destination that belongs to another trip", async () => {
    const trip = await tripWithDates();
    const otherTrip = await tripWithDates();
    const result = await pool.query(
      `INSERT INTO destinations (trip_id, city, country) VALUES ($1, 'Cairo', 'Egypt') RETURNING id`,
      [otherTrip.id],
    );

    await expect(
      addItineraryItem(trip.id, ownerId, {
        day: "2026-10-03",
        title: "Wrong trip's city",
        destinationId: result.rows[0].id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a non-owner the same way whether or not the trip exists", async () => {
    const trip = await tripWithDates();
    await expect(
      addItineraryItem(trip.id, otherId, { day: "2026-10-03", title: "Intruder" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("updateItineraryItem", () => {
  it("clears a wrong cost with explicit nulls and leaves other fields alone", async () => {
    const trip = await tripWithDates();
    const item = await addItineraryItem(trip.id, ownerId, {
      day: "2026-10-03",
      title: "Dinner",
      startTime: "19:00",
      estimatedCost: 80,
      currency: "EUR",
    });

    const updated = await updateItineraryItem(trip.id, item.id, ownerId, {
      estimatedCost: null,
      currency: null,
    });

    expect(updated.estimatedCost).toBeNull();
    expect(updated.currency).toBeNull();
    expect(updated.title).toBe("Dinner");
    expect(updated.startTime).toBe("19:00");
  });

  it("rejects moving an item to a day outside the trip", async () => {
    const trip = await tripWithDates();
    const item = await addItineraryItem(trip.id, ownerId, { day: "2026-10-03", title: "Move me" });

    await expect(
      updateItineraryItem(trip.id, item.id, ownerId, { day: "2026-10-09" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses an item id that lives on a different trip", async () => {
    const trip = await tripWithDates();
    const otherTrip = await tripWithDates();
    const item = await addItineraryItem(otherTrip.id, ownerId, {
      day: "2026-10-03",
      title: "Elsewhere",
    });

    await expect(
      updateItineraryItem(trip.id, item.id, ownerId, { title: "Hijack" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("deleteItineraryItem", () => {
  it("removes the item and records the event", async () => {
    const trip = await tripWithDates();
    const item = await addItineraryItem(trip.id, ownerId, {
      day: "2026-10-03",
      title: "Remove me",
    });

    await deleteItineraryItem(trip.id, item.id, ownerId);

    const { items } = await listTripItinerary(trip.id, ownerId);
    expect(items).toEqual([]);
    const events = await getTripEventHistory(trip.id, ownerId);
    expect(events.some((event) => event.eventType === "ITINERARY_ITEM_REMOVED")).toBe(true);
  });
});

describe("budget status (deterministic)", () => {
  it("reports no cap and exact per-currency totals without any provider call", async () => {
    const trip = await tripWithDates();
    await addItineraryItem(trip.id, ownerId, {
      day: "2026-10-03",
      title: "Hotel",
      estimatedCost: 400,
      currency: "AED",
    });
    await addItineraryItem(trip.id, ownerId, {
      day: "2026-10-04",
      title: "Tour",
      estimatedCost: 150.25,
      currency: "AED",
    });
    await addItineraryItem(trip.id, ownerId, {
      day: "2026-10-05",
      title: "Unknown price",
    });

    const { budget } = await listTripItinerary(trip.id, ownerId);

    expect(budget.configured).toBe(false);
    expect(budget.converted).toBeNull();
    expect(budget.itemsWithoutCost).toBe(1);
    expect(budget.totalsByCurrency).toEqual([{ currency: "AED", amount: 550.25, itemCount: 2 }]);
    // No cap means no conversion should ever have been attempted.
    expect(mockGetExchangeRate).not.toHaveBeenCalled();
  });

  it("converts every costed item to the budget currency and reports the true position", async () => {
    const trip = await tripWithDates();
    await setTripBudget(trip.id, ownerId, { amount: 1000, currency: "AED" });
    await addItineraryItem(trip.id, ownerId, {
      day: "2026-10-03",
      title: "Hotel",
      estimatedCost: 400,
      currency: "AED",
    });
    await addItineraryItem(trip.id, ownerId, {
      day: "2026-10-04",
      title: "Tour",
      estimatedCost: 100,
      currency: "USD",
    });

    mockGetExchangeRate.mockResolvedValue({
      base: "USD",
      target: "AED",
      rate: 3.6725,
      asOf: "2026-10-01T00:00:00.000Z",
    });

    const { budget } = await listTripItinerary(trip.id, ownerId);
    if (!budget.converted) throw new Error("expected a converted budget");

    // 400 AED + (100 USD * 3.6725) = 767.25 AED
    expect(budget.converted.total).toBe(767.25);
    expect(budget.converted.remaining).toBe(232.75);
    expect(budget.converted.overBudget).toBe(false);
    // One provider lookup for the one non-target currency, not one per item.
    expect(mockGetExchangeRate).toHaveBeenCalledTimes(1);
    const usdLine = budget.converted.lines.find((line) => line.currency === "USD");
    expect(usdLine?.convertedAmount).toBe(367.25);
    // The same-currency line carries rate 1 and no fetched timestamp.
    const aedLine = budget.converted.lines.find((line) => line.currency === "AED");
    expect(aedLine?.exchangeRate).toBe(1);
    expect(aedLine?.rateAsOf).toBeNull();
  });

  it("flags an over-budget position with the overspend amount", async () => {
    const trip = await tripWithDates();
    await setTripBudget(trip.id, ownerId, { amount: 500, currency: "AED" });
    await addItineraryItem(trip.id, ownerId, {
      day: "2026-10-03",
      title: "Hotel",
      estimatedCost: 400,
      currency: "AED",
    });
    await addItineraryItem(trip.id, ownerId, {
      day: "2026-10-04",
      title: "Tour",
      estimatedCost: 100,
      currency: "USD",
    });
    mockGetExchangeRate.mockResolvedValue({
      base: "USD",
      target: "AED",
      rate: 3.6725,
      asOf: "2026-10-01T00:00:00.000Z",
    });

    const { budget } = await listTripItinerary(trip.id, ownerId);
    if (!budget.converted) throw new Error("expected a converted budget");

    expect(budget.converted.total).toBe(767.25);
    expect(budget.converted.overBudget).toBe(true);
    expect(budget.converted.remaining).toBe(-267.25);
  });

  it("withholds the converted total entirely when one rate is unavailable", async () => {
    const trip = await tripWithDates();
    await setTripBudget(trip.id, ownerId, { amount: 1000, currency: "AED" });
    await addItineraryItem(trip.id, ownerId, {
      day: "2026-10-03",
      title: "Hotel",
      estimatedCost: 400,
      currency: "AED",
    });
    await addItineraryItem(trip.id, ownerId, {
      day: "2026-10-04",
      title: "Tour",
      estimatedCost: 100,
      currency: "USD",
    });

    mockGetExchangeRate.mockRejectedValue(new ProviderError("fixer", "Rates are unavailable."));

    const { budget } = await listTripItinerary(trip.id, ownerId);

    // A partial sum presented as "the total" would be a fabricated metric.
    expect(budget.converted).toBeNull();
    expect(budget.conversionError).toBe("Rates are unavailable.");
    // The exact per-currency totals are still true and still there.
    expect(budget.totalsByCurrency).toEqual([
      { currency: "AED", amount: 400, itemCount: 1 },
      { currency: "USD", amount: 100, itemCount: 1 },
    ]);
  });

  it("clears a budget cap and returns to the unconfigured state", async () => {
    const trip = await tripWithDates();
    await setTripBudget(trip.id, ownerId, { amount: 900, currency: "EUR" });
    const cleared = await setTripBudget(trip.id, ownerId, null);

    expect(cleared.configured).toBe(false);
    const { budget } = await listTripItinerary(trip.id, ownerId);
    expect(budget.configured).toBe(false);
    expect(budget.limit).toBeNull();
  });

  it("refuses a non-owner's budget write", async () => {
    const trip = await tripWithDates();
    await expect(
      setTripBudget(trip.id, otherId, { amount: 100, currency: "USD" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("replaceGeneratedPlan", () => {
  const draft = (title: string, day: string): PlanItemDraft => ({
    itineraryDay: day,
    startTime: "10:00",
    endTime: null,
    title,
    itemType: "ACTIVITY",
    location: null,
    destinationId: null,
    notes: null,
  });

  it("replaces AI items while leaving the traveler's own items untouched", async () => {
    const trip = await tripWithDates();

    // First planning run.
    await replaceGeneratedPlan(trip.id, ownerId, "run-1", [
      draft("Old AI item", "2026-10-03"),
      draft("Another AI item", "2026-10-04"),
    ]);

    // The traveler adds their own item between runs.
    const userItem = await addItineraryItem(trip.id, ownerId, {
      day: "2026-10-03",
      title: "My own booking",
    });

    const secondRun = await replaceGeneratedPlan(trip.id, ownerId, "run-2", [
      draft("New AI item", "2026-10-05"),
    ]);

    expect(secondRun.replacedCount).toBe(2);
    expect(secondRun.items).toHaveLength(1);
    expect(secondRun.items[0].planRunId).toBe("run-2");

    const { items } = await listTripItinerary(trip.id, ownerId);
    const titles = items.map((item) => item.title).sort();
    expect(titles).toEqual(["My own booking", "New AI item"]);
    expect(items.find((item) => item.id === userItem.id)).toBeDefined();

    const events = await getTripEventHistory(trip.id, ownerId);
    const planned = events.find((event) => event.eventType === "ITINERARY_PLANNED");
    expect(planned?.metadata).toMatchObject({ planRunId: "run-2", itemsCreated: 1 });
  });
});
