import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { addTravelerToTrip } from "@/modules/trip/trip-service";
import { addTravelerSchema } from "@/modules/trip/validation";

export const POST = withApiHandler(async (_requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  const body = await request.json();
  const input = addTravelerSchema.parse(body);

  const traveler = await addTravelerToTrip(id, user.id, input);
  log.info({ tripId: id, travelerId: traveler.id }, "Traveler added");
  return { traveler };
});
