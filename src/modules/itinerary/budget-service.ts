import { getCurrencyProvider } from "@/integrations/currency/provider";
import { isAppError } from "@/shared/errors";
import type { TripRecord } from "@/modules/trip/trip-repository";
import type { ItineraryItemRecord } from "./itinerary-repository";

/**
 * Deterministic budget validation for an itinerary (Phase 20).
 *
 * This file contains no AI and no arithmetic done by a model. Every
 * number here is either read from a stored item (a cost the traveler
 * entered) or comes from the currency provider, and the multiplication
 * happens in code. The planning agent is *told* about these numbers
 * through the `get_trip_itinerary` tool so it can plan sensibly around a
 * budget — it is never asked to compute one.
 *
 * Honesty rules this module follows, matching the project brief:
 *
 *  - Never invent a price. Items without a recorded cost are counted and
 *    reported (`itemsWithoutCost`), never assumed to cost zero or some
 *    default. A total that quietly treated unknown costs as 0 would be a
 *    fabricated metric.
 *  - Per-currency totals are always exact and always available: they are
 *    pure sums of stored values, no provider involved.
 *  - The converted total only exists when every costed item's rate is
 *    actually available. One unavailable rate means `converted: null` and
 *    an explicit `conversionError` — never a partial sum presented as
 *    "the total".
 */

export interface CurrencyTotal {
  currency: string;
  amount: number;
  itemCount: number;
}

export interface ConvertedLine {
  itemId: string;
  title: string;
  currency: string;
  amount: number;
  exchangeRate: number;
  /** null for same-currency lines, where no rate was fetched. */
  rateAsOf: string | null;
  convertedAmount: number;
}

export interface BudgetConversion {
  currency: string;
  limit: number;
  total: number;
  remaining: number;
  overBudget: boolean;
  lines: ConvertedLine[];
}

export interface ItineraryBudgetStatus {
  configured: boolean;
  currency: string | null;
  limit: number | null;
  totalsByCurrency: CurrencyTotal[];
  itemsWithoutCost: number;
  costedItemCount: number;
  converted: BudgetConversion | null;
  conversionError: string | null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function computeItineraryBudgetStatus(
  trip: TripRecord,
  items: ItineraryItemRecord[],
): Promise<ItineraryBudgetStatus> {
  const totals = new Map<string, CurrencyTotal>();
  const costed: ItineraryItemRecord[] = [];
  let itemsWithoutCost = 0;

  for (const item of items) {
    if (item.estimatedCost === null || item.currency === null) {
      itemsWithoutCost += 1;
      continue;
    }
    costed.push(item);
    const entry = totals.get(item.currency) ?? { currency: item.currency, amount: 0, itemCount: 0 };
    entry.amount = round2(entry.amount + item.estimatedCost);
    entry.itemCount += 1;
    totals.set(item.currency, entry);
  }

  const totalsByCurrency = [...totals.values()].sort((a, b) =>
    a.currency.localeCompare(b.currency),
  );

  const configured = trip.budgetAmount !== null && trip.budgetCurrency !== null;
  if (!configured) {
    return {
      configured: false,
      currency: null,
      limit: null,
      totalsByCurrency,
      itemsWithoutCost,
      costedItemCount: costed.length,
      converted: null,
      conversionError: null,
    };
  }

  const targetCurrency = trip.budgetCurrency as string;
  const limit = trip.budgetAmount as number;

  try {
    const provider = getCurrencyProvider();
    // One lookup per distinct currency, not per item: a plan with ten
    // AED-priced items must not make ten identical provider calls.
    const rateCache = new Map<string, { rate: number; asOf: string }>();

    const lines: ConvertedLine[] = [];
    for (const item of costed) {
      const sourceCurrency = item.currency as string;
      const amount = item.estimatedCost as number;

      let exchangeRate: number;
      let rateAsOf: string | null;

      if (sourceCurrency === targetCurrency) {
        exchangeRate = 1;
        rateAsOf = null;
      } else {
        const cached = rateCache.get(sourceCurrency);
        if (cached) {
          exchangeRate = cached.rate;
          rateAsOf = cached.asOf;
        } else {
          const fetched = await provider.getExchangeRate(sourceCurrency, targetCurrency);
          rateCache.set(sourceCurrency, { rate: fetched.rate, asOf: fetched.asOf });
          exchangeRate = fetched.rate;
          rateAsOf = fetched.asOf;
        }
      }

      lines.push({
        itemId: item.id,
        title: item.title,
        currency: sourceCurrency,
        amount,
        exchangeRate,
        rateAsOf,
        convertedAmount: round2(amount * exchangeRate),
      });
    }

    const total = round2(lines.reduce((sum, line) => sum + line.convertedAmount, 0));

    return {
      configured: true,
      currency: targetCurrency,
      limit,
      totalsByCurrency,
      itemsWithoutCost,
      costedItemCount: costed.length,
      converted: {
        currency: targetCurrency,
        limit,
        total,
        remaining: round2(limit - total),
        overBudget: total > limit,
        lines,
      },
      conversionError: null,
    };
  } catch (error) {
    // A missing rate is reported as exactly that. The per-currency totals
    // above are still true and still returned; only the converted view is
    // withheld.
    return {
      configured: true,
      currency: targetCurrency,
      limit,
      totalsByCurrency,
      itemsWithoutCost,
      costedItemCount: costed.length,
      converted: null,
      conversionError: isAppError(error)
        ? error.message
        : "The currency provider failed, so costs could not be converted to the budget currency.",
    };
  }
}
