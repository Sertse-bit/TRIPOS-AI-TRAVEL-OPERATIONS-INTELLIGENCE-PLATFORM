import { describe, expect, it } from "vitest";
import {
  addItineraryItemSchema,
  itineraryCurrencySchema,
  itineraryDaySchema,
  itineraryTimeSchema,
  setTripBudgetSchema,
  updateItineraryItemSchema,
} from "@/modules/itinerary/validation";

/**
 * The itinerary validation schemas (Phase 27) are the front door of the
 * Phase 20 budget guarantee: a cost without a currency (or either one
 * alone in an update) must never reach the service, because the budget
 * validator's whole-job is comparing totals in one currency. These pin
 * the pair rule, the time/day formats the database CHECK constraints
 * mirror, and the create-vs-update difference on optional fields.
 */

const VALID_BASE = {
  day: "2026-11-02",
  title: "Ferry to Madeira",
};

describe("field formats", () => {
  it("accepts 24-hour HH:MM times and rejects everything else", () => {
    expect(itineraryTimeSchema.safeParse("09:30").success).toBe(true);
    expect(itineraryTimeSchema.safeParse("23:59").success).toBe(true);
    expect(itineraryTimeSchema.safeParse("00:00").success).toBe(true);
    expect(itineraryTimeSchema.safeParse("24:00").success).toBe(false);
    expect(itineraryTimeSchema.safeParse("9:30").success).toBe(false);
    expect(itineraryTimeSchema.safeParse("09:5").success).toBe(false);
    expect(itineraryTimeSchema.safeParse("09:30:00").success).toBe(false);
    expect(itineraryTimeSchema.safeParse("").success).toBe(false);
  });

  it("accepts only strict YYYY-MM-DD days", () => {
    expect(itineraryDaySchema.safeParse("2026-11-02").success).toBe(true);
    expect(itineraryDaySchema.safeParse("11/02/2026").success).toBe(false);
    expect(itineraryDaySchema.safeParse("2026-1-2").success).toBe(false);
    expect(itineraryDaySchema.safeParse("2026-11").success).toBe(false);
    expect(itineraryDaySchema.safeParse("2026-11-02T00:00:00Z").success).toBe(false);
    // The regex pins the FORMAT only — the same contract as the database's
    // CHECK constraint. Month/day plausibility is the database's job, and
    // '2026-99-99' passes the regex by design (and is then the DB's to
    // reject, which it does).
    expect(itineraryDaySchema.safeParse("2026-99-99").success).toBe(true);
  });

  it("normalises currency codes to upper case and requires exactly three characters", () => {
    expect(itineraryCurrencySchema.parse(" usd ")).toBe("USD");
    expect(itineraryCurrencySchema.safeParse("US").success).toBe(false);
    expect(itineraryCurrencySchema.safeParse("USDD").success).toBe(false);
    expect(itineraryCurrencySchema.safeParse("us d").success).toBe(false);
    // Three characters, whatever they are: the ISO-4217 check is not this
    // schema's job, and '12€' is exactly the kind of value the cost/currency
    // pairing exists to keep out of arithmetic — see budget-service, which
    // resolves codes against real rates before comparing anything.
    expect(itineraryCurrencySchema.parse("12€")).toBe("12€");
  });
});

describe("addItineraryItemSchema — the cost/currency pair rule", () => {
  it("accepts a full item with a cost and its currency", () => {
    const parsed = addItineraryItemSchema.parse({
      ...VALID_BASE,
      estimatedCost: 42.5,
      currency: "EUR",
    });
    expect(parsed.estimatedCost).toBe(42.5);
    expect(parsed.currency).toBe("EUR");
    expect(parsed.itemType).toBeUndefined();
  });

  it("accepts an item with no cost at all (both absent)", () => {
    expect(addItineraryItemSchema.safeParse(VALID_BASE).success).toBe(true);
  });

  it("rejects a cost without a currency and a currency without a cost", () => {
    expect(addItineraryItemSchema.safeParse({ ...VALID_BASE, estimatedCost: 10 }).success).toBe(
      false,
    );
    expect(addItineraryItemSchema.safeParse({ ...VALID_BASE, currency: "USD" }).success).toBe(
      false,
    );
  });

  it("rejects a negative cost and an absurd one", () => {
    expect(
      addItineraryItemSchema.safeParse({ ...VALID_BASE, estimatedCost: -1, currency: "USD" })
        .success,
    ).toBe(false);
    expect(
      addItineraryItemSchema.safeParse({
        ...VALID_BASE,
        estimatedCost: 10_000_001,
        currency: "USD",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown item type", () => {
    expect(
      addItineraryItemSchema.safeParse({ ...VALID_BASE, itemType: "spontaneous" }).success,
    ).toBe(false);
  });
});

describe("updateItineraryItemSchema — explicit nulls clear, absence leaves", () => {
  it("accepts null cost and null currency together (clearing both)", () => {
    const parsed = updateItineraryItemSchema.parse({ estimatedCost: null, currency: null });
    expect(parsed.estimatedCost).toBeNull();
    expect(parsed.currency).toBeNull();
  });

  it("rejects clearing only one half of the pair", () => {
    expect(updateItineraryItemSchema.safeParse({ estimatedCost: null }).success).toBe(false);
    expect(updateItineraryItemSchema.safeParse({ currency: null }).success).toBe(false);
  });

  it("rejects setting only one half of the pair", () => {
    expect(updateItineraryItemSchema.safeParse({ estimatedCost: 20 }).success).toBe(false);
    expect(updateItineraryItemSchema.safeParse({ currency: "EUR" }).success).toBe(false);
  });

  it("rejects a mixed set/clear (one null, one real)", () => {
    expect(
      updateItineraryItemSchema.safeParse({ estimatedCost: null, currency: "EUR" }).success,
    ).toBe(false);
    expect(updateItineraryItemSchema.safeParse({ estimatedCost: 20, currency: null }).success).toBe(
      false,
    );
  });

  it("lets unrelated fields update without touching the pair", () => {
    const parsed = updateItineraryItemSchema.parse({ title: "New title", notes: null });
    expect(parsed.title).toBe("New title");
    expect(parsed.notes).toBeNull();
    expect(parsed.estimatedCost).toBeUndefined();
  });
});

describe("setTripBudgetSchema", () => {
  it("requires a positive amount and a currency", () => {
    expect(setTripBudgetSchema.safeParse({ amount: 1500, currency: "usd" }).success).toBe(true);
    expect(setTripBudgetSchema.parse({ amount: 1500, currency: "usd" }).currency).toBe("USD");
    expect(setTripBudgetSchema.safeParse({ amount: 0, currency: "USD" }).success).toBe(false);
    expect(setTripBudgetSchema.safeParse({ amount: -5, currency: "USD" }).success).toBe(false);
    expect(setTripBudgetSchema.safeParse({ amount: 1500 }).success).toBe(false);
  });
});
