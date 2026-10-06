import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { changeTripStatus, getTrip } from "@/modules/trip/trip-service";
import { changeTripStatusSchema } from "@/modules/trip/validation";
import { auditTripStatusChanged } from "@/modules/audit/route-audit";

export const PATCH = withApiHandler(async (requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  const body = await request.json();
  const { status } = changeTripStatusSchema.parse(body);

  // Read before the change so the audit row records the transition,
  // not just the destination state.
  const previousStatus = (await getTrip(id, user.id)).status;
  const trip = await changeTripStatus(id, user.id, status);
  auditTripStatusChanged({ requestId, userId: user.id, trip, previousStatus });
  log.info({ tripId: id, status }, "Trip status changed");
  return { trip };
});
