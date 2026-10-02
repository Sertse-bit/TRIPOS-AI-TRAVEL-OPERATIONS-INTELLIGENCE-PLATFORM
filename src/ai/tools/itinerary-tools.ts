import { z } from "zod";
import { defineTool } from "@/ai/tools/types";
import { listTripItinerary } from "@/modules/itinerary/itinerary-service";

/**
 * The itinerary read tool (Phase 20). Read-only on purpose: this is how
 * the planning agent learns what the traveler already scheduled and how
 * the budget actually stands, before it composes anything. Persisting a
 * plan is the caller's job, not a tool the model can fire mid-reasoning.
 *
 * The budget figures returned here are computed deterministically in
 * modules/itinerary/budget-service.ts. The model is handed them; it is
 * never asked to produce or adjust one.
 */
export const getTripItineraryTool = defineTool({
  name: "get_trip_itinerary",
  description:
    "Read this trip's current day-by-day itinerary (items already scheduled) plus its deterministic budget status: costs grouped by currency, the configured budget cap, and how much of it is used. Use this before planning so you build on existing items instead of duplicating them, and to see whether cost is a constraint.",
  inputSchema: z.object({
    tripId: z.string().uuid(),
  }),
  execute: async (input, context) => {
    const { items, budget } = await listTripItinerary(input.tripId, context.userId);

    return {
      items: items.map((item) => ({
        id: item.id,
        day: item.itineraryDay,
        startTime: item.startTime,
        endTime: item.endTime,
        title: item.title,
        itemType: item.itemType,
        location: item.location,
        notes: item.notes,
        // Present only for items whose cost the traveler actually recorded.
        // An item without a cost is reported as null, never as zero.
        estimatedCost: item.estimatedCost,
        currency: item.currency,
        source: item.source,
      })),
      budget,
    };
  },
});
