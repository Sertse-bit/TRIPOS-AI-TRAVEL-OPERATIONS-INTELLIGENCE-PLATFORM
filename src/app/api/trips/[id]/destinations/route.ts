import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { addDestinationToTrip } from "@/modules/trip/trip-service";
import { addDestinationSchema } from "@/modules/trip/validation";

export const POST = withApiHandler(async (_requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  const body = await request.json();
  const input = addDestinationSchema.parse(body);

  const destination = await addDestinationToTrip(id, user.id, input);
  log.info({ tripId: id, destinationId: destination.id }, "Destination added");
  return { destination };
});
