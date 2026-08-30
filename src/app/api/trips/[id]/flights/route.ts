import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { addFlightToTrip } from "@/modules/trip/trip-service";
import { addFlightSchema } from "@/modules/trip/validation";

export const POST = withApiHandler(async (_requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  const body = await request.json();
  const input = addFlightSchema.parse(body);

  const flight = await addFlightToTrip(id, user.id, input);
  log.info({ tripId: id, flightId: flight.id }, "Flight added");
  return { flight };
});
