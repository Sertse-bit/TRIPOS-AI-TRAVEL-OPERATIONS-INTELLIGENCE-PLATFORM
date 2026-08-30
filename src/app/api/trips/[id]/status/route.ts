import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { changeTripStatus } from "@/modules/trip/trip-service";
import { changeTripStatusSchema } from "@/modules/trip/validation";

export const PATCH = withApiHandler(async (_requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  const body = await request.json();
  const { status } = changeTripStatusSchema.parse(body);

  const trip = await changeTripStatus(id, user.id, status);
  log.info({ tripId: id, status }, "Trip status changed");
  return { trip };
});
