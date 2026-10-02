import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { deleteItineraryItem, updateItineraryItem } from "@/modules/itinerary/itinerary-service";
import { updateItineraryItemSchema } from "@/modules/itinerary/validation";

/**
 * One itinerary item (Phase 20).
 *
 * PATCH accepts explicit nulls to clear optional fields (a wrong cost, a
 * stale time) — distinct from omitting a field, which leaves it alone.
 * DELETE removes only the traveler's chosen row; a regenerated AI plan
 * replaces its own rows separately.
 */
export const PATCH = withApiHandler(async (_requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id, itemId } = await context.params;
  const body = updateItineraryItemSchema.parse(await request.json());

  const item = await updateItineraryItem(id, itemId, user.id, body);

  log.info({ tripId: id, itemId }, "Itinerary item updated");
  return { item };
});

export const DELETE = withApiHandler(async (_requestId, log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id, itemId } = await context.params;

  await deleteItineraryItem(id, itemId, user.id);

  log.info({ tripId: id, itemId }, "Itinerary item deleted");
  return { deleted: true };
});
