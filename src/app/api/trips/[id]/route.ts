import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { getTripDigitalTwin, updateTripDetails } from "@/modules/trip/trip-service";
import { updateTripSchema } from "@/modules/trip/validation";
import { auditTripUpdated } from "@/modules/audit/route-audit";

export const GET = withApiHandler(async (_requestId, _log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  return getTripDigitalTwin(id, user.id);
});

export const PATCH = withApiHandler(async (requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  const body = await request.json();
  const input = updateTripSchema.parse(body);

  const trip = await updateTripDetails(id, user.id, input);
  // Which fields the request actually carried — what changed, not what
  // the row now looks like (the log line and the envelope have the rest).
  auditTripUpdated({ requestId, userId: user.id, trip, changedFields: Object.keys(input) });
  log.info({ tripId: id }, "Trip updated");
  return { trip };
});
