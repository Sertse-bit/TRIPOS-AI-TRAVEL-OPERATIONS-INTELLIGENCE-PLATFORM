import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { addDestinationToTrip, getTrip } from "@/modules/trip/trip-service";
import { addDestinationSchema } from "@/modules/trip/validation";
import { auditDestinationAdded } from "@/modules/audit/route-audit";

export const POST = withApiHandler(async (requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  const body = await request.json();
  const input = addDestinationSchema.parse(body);

  const destination = await addDestinationToTrip(id, user.id, input);
  const trip = await getTrip(id, user.id);
  auditDestinationAdded({ requestId, userId: user.id, trip, destination });
  log.info({ tripId: id, destinationId: destination.id }, "Destination added");
  return { destination };
});
