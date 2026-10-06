import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { addTravelerToTrip, getTrip } from "@/modules/trip/trip-service";
import { addTravelerSchema } from "@/modules/trip/validation";
import { auditTravelerAdded } from "@/modules/audit/route-audit";

export const POST = withApiHandler(async (requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  const body = await request.json();
  const input = addTravelerSchema.parse(body);

  const traveler = await addTravelerToTrip(id, user.id, input);
  const trip = await getTrip(id, user.id);
  auditTravelerAdded({ requestId, userId: user.id, trip, travelerId: traveler.id });
  log.info({ tripId: id, travelerId: traveler.id }, "Traveler added");
  return { traveler };
});
