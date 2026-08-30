import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { getTripDigitalTwin, updateTripDetails } from "@/modules/trip/trip-service";
import { updateTripSchema } from "@/modules/trip/validation";

export const GET = withApiHandler(async (_requestId, _log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  return getTripDigitalTwin(id, user.id);
});

export const PATCH = withApiHandler(async (_requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  const body = await request.json();
  const input = updateTripSchema.parse(body);

  const trip = await updateTripDetails(id, user.id, input);
  log.info({ tripId: id }, "Trip updated");
  return { trip };
});
