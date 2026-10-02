import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { addItineraryItem, listTripItinerary } from "@/modules/itinerary/itinerary-service";
import { addItineraryItemSchema } from "@/modules/itinerary/validation";

/**
 * A trip's itinerary (Phase 20).
 *
 * GET returns the day-by-day items plus the deterministic budget status.
 * POST adds a traveler-written item; AI-generated plans arrive through
 * POST .../itinerary/plan instead, and are stored as a separate source so
 * the two writers never clobber each other.
 */
export const GET = withApiHandler(async (_requestId, _log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  return listTripItinerary(id, user.id);
});

export const POST = withApiHandler(async (_requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  const body = addItineraryItemSchema.parse(await request.json());

  const item = await addItineraryItem(id, user.id, body);

  log.info(
    { tripId: id, itemId: item.id, day: item.itineraryDay, itemType: item.itemType },
    "Itinerary item added",
  );
  return { item };
});
