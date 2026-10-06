import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { addItineraryItem, listTripItinerary } from "@/modules/itinerary/itinerary-service";
import { addItineraryItemSchema } from "@/modules/itinerary/validation";
import { getTrip } from "@/modules/trip/trip-service";
import { auditItineraryItemAdded } from "@/modules/audit/route-audit";

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

export const POST = withApiHandler(async (requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  const body = addItineraryItemSchema.parse(await request.json());

  const item = await addItineraryItem(id, user.id, body);
  const trip = await getTrip(id, user.id);
  auditItineraryItemAdded({
    requestId,
    userId: user.id,
    trip,
    itemId: item.id,
    itemType: item.itemType,
    source: "traveler",
  });

  log.info(
    { tripId: id, itemId: item.id, day: item.itineraryDay, itemType: item.itemType },
    "Itinerary item added",
  );
  return { item };
});
