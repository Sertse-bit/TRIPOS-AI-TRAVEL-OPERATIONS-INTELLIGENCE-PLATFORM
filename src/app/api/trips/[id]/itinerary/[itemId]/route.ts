import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { deleteItineraryItem, updateItineraryItem } from "@/modules/itinerary/itinerary-service";
import { updateItineraryItemSchema } from "@/modules/itinerary/validation";
import { getTrip } from "@/modules/trip/trip-service";
import { auditItineraryItemUpdated, auditItineraryItemDeleted } from "@/modules/audit/route-audit";

/**
 * One itinerary item (Phase 20).
 *
 * PATCH accepts explicit nulls to clear optional fields (a wrong cost, a
 * stale time) — distinct from omitting a field, which leaves it alone.
 * DELETE removes only the traveler's chosen row; a regenerated AI plan
 * replaces its own rows separately.
 */
export const PATCH = withApiHandler(async (requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id, itemId } = await context.params;
  const body = updateItineraryItemSchema.parse(await request.json());

  const item = await updateItineraryItem(id, itemId, user.id, body);
  const trip = await getTrip(id, user.id);
  auditItineraryItemUpdated({ requestId, userId: user.id, trip, itemId });

  log.info({ tripId: id, itemId }, "Itinerary item updated");
  return { item };
});

export const DELETE = withApiHandler(async (requestId, log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id, itemId } = await context.params;

  await deleteItineraryItem(id, itemId, user.id);
  const trip = await getTrip(id, user.id);
  auditItineraryItemDeleted({ requestId, userId: user.id, trip, itemId });

  log.info({ tripId: id, itemId }, "Itinerary item deleted");
  return { deleted: true };
});
