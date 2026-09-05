import { getCurrencyProvider } from "@/integrations/currency/provider";
import { recordCurrencySnapshot as recordCurrencySnapshotRow } from "@/modules/trip/currency-snapshot-repository";
import { recordTripEvent } from "@/modules/trip/trip-event-repository";
import { getTrip } from "@/modules/trip/trip-service";

/**
 * Deliberately lighter than the Flight and Weather agents. Re-reading
 * the brief's actual scope for this phase — retrieval, normalization,
 * conversion, timestamped snapshots, caching — it does NOT list "detect
 * significant changes" or "compare against previous snapshot" the way
 * Phases 10/11 explicitly do for their agents. That's respected here as
 * a deliberate scope difference, not an oversight: a flight cancellation
 * or a thunderstorm is actionable in a way an ordinary currency-rate
 * fluctuation for a travel budget generally isn't. If currency
 * volatility ever needs to be a first-class alert, it fits naturally as
 * one more factor in Phase 16's Risk Engine rather than being retrofitted
 * here.
 *
 * Retrieval, normalization, caching, and resilient dual-vendor fallback
 * already exist end-to-end from Phase 5/6. What this agent actually adds:
 * a single cohesive call that retrieves the rate AND records the
 * timestamped snapshot together (previously two separate, unconnected
 * calls a caller had to remember to make both of), plus a shared,
 * tested conversion utility instead of the inline multiplication that
 * was duplicated in the calculate_budget tool.
 */

/**
 * Extracted from ai/tools/budget-tools.ts's calculate_budget, which
 * previously did this multiplication inline. Sharing one implementation
 * means the rounding behavior can't quietly drift between the tool and
 * this agent if either is ever changed independently.
 */
export function convertCurrencyAmount(amount: number, rate: number): number {
  return Math.round(amount * rate * 100) / 100;
}

export interface CurrencyAgentResult {
  tripId: string;
  baseCurrency: string;
  targetCurrency: string;
  rate: number;
  rateAsOf: string;
  snapshotId: string;
  convertedAmount: number | null;
}

/**
 * Pure domain operation, no userId -- available for Phase 19's Trip
 * Watch to call directly later if periodic rate refresh for active
 * trips is ever wanted, matching the same two-layer pattern as the
 * Flight and Weather agents.
 */
export async function getExchangeRateSnapshot(
  tripId: string,
  baseCurrency: string,
  targetCurrency: string,
  amount?: number,
): Promise<CurrencyAgentResult> {
  const rate = await getCurrencyProvider().getExchangeRate(baseCurrency, targetCurrency);

  // Calls the repository and event emission directly, matching how the
  // Flight and Weather agents' pure functions work -- NOT through
  // trip-service's recordCurrencySnapshot, which internally requires a
  // real, valid userId for its ownership check and would always throw
  // given a placeholder like "system" (no trip is ever owned by a user
  // literally named that). This is what makes the function genuinely
  // usable without a user context, the entire point of the pure/
  // user-facing split.
  const snapshot = await recordCurrencySnapshotRow({
    tripId,
    baseCurrency,
    targetCurrency,
    rate: rate.rate,
    provider: getCurrencyProvider().providerName,
    fetchedAt: new Date(rate.asOf),
  });

  // Consistent with this phase's simpler scope (no "was this
  // significant" gate the brief doesn't ask for here, unlike Phases
  // 10/11): every snapshot is worth recording in the audit history.
  await recordTripEvent({
    tripId,
    eventType: "CURRENCY_SNAPSHOT_RECORDED",
    entityType: "currency_snapshot",
    entityId: snapshot.id,
    metadata: { pair: `${baseCurrency}/${targetCurrency}`, rate: rate.rate },
  });

  return {
    tripId,
    baseCurrency,
    targetCurrency,
    rate: rate.rate,
    rateAsOf: rate.asOf,
    snapshotId: snapshot.id,
    convertedAmount: amount !== undefined ? convertCurrencyAmount(amount, rate.rate) : null,
  };
}

/**
 * User-facing entry point: verifies trip ownership (Phase 7) first, then
 * delegates to the same core operation above -- matching how the Flight
 * and Weather agents' user-facing wrappers work, rather than
 * reimplementing the fetch-and-record logic a second time here.
 */
export async function runCurrencyAgentForUser(
  tripId: string,
  userId: string,
  baseCurrency: string,
  targetCurrency: string,
  amount?: number,
): Promise<CurrencyAgentResult> {
  await getTrip(tripId, userId);
  return getExchangeRateSnapshot(tripId, baseCurrency, targetCurrency, amount);
}
