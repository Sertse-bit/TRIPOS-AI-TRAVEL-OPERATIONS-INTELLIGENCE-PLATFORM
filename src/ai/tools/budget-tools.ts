import { z } from "zod";
import { defineTool } from "@/ai/tools/types";
import { getTrip } from "@/modules/trip/trip-service";
import { getCurrencyProvider } from "@/integrations/currency/provider";

/**
 * Deliberately narrow scope: this is a currency conversion calculator,
 * not a full trip budget planner. No itinerary/lodging/activity cost
 * data model exists yet to plan a real budget against -- that's Phase
 * 20's job (AI Itinerary Planner, which explicitly validates "budget
 * limits" once real cost data exists). Building a fuller "budget" tool
 * now would mean inventing cost figures with nothing behind them, which
 * the brief explicitly forbids ("never invent... production metrics").
 *
 * What this tool does do is genuinely deterministic (brief: "Do not use
 * AI where deterministic logic is better") -- the multiplication happens
 * in code, not as something an LLM is asked to compute or guess at.
 */
export const calculateBudgetTool = defineTool({
  name: "calculate_budget",
  description:
    "Convert an amount from one currency to another using a live exchange rate, for budget planning. This is a currency conversion, not a full trip cost estimate -- it does not know about flight, hotel, or activity prices.",
  inputSchema: z.object({
    tripId: z.string().uuid(),
    amount: z.number().positive(),
    fromCurrency: z.string().length(3).toUpperCase(),
    toCurrency: z.string().length(3).toUpperCase(),
  }),
  execute: async (input, context) => {
    await getTrip(input.tripId, context.userId);

    const rate = await getCurrencyProvider().getExchangeRate(input.fromCurrency, input.toCurrency);
    const convertedAmount = Math.round(input.amount * rate.rate * 100) / 100;

    return {
      originalAmount: input.amount,
      fromCurrency: input.fromCurrency,
      toCurrency: input.toCurrency,
      exchangeRate: rate.rate,
      convertedAmount,
      rateAsOf: rate.asOf,
    };
  },
});
