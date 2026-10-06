import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { setTripBudget } from "@/modules/itinerary/itinerary-service";
import { setTripBudgetSchema } from "@/modules/itinerary/validation";
import { getTrip } from "@/modules/trip/trip-service";
import { auditBudgetChanged } from "@/modules/audit/route-audit";

/**
 * The trip's budget cap (Phase 20).
 *
 * PUT sets it, DELETE clears it — two explicit verbs rather than a
 * nullable body, so "no budget configured" is a state the API can express
 * unambiguously. Both return the recomputed budget status.
 */
export const PUT = withApiHandler(async (requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  const body = setTripBudgetSchema.parse(await request.json());

  const trip = await getTrip(id, user.id);
  const budget = await setTripBudget(id, user.id, body);
  auditBudgetChanged({ requestId, userId: user.id, trip, currency: body.currency });

  log.info({ tripId: id, currency: body.currency }, "Trip budget set");
  return { budget };
});

export const DELETE = withApiHandler(async (requestId, log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;

  const trip = await getTrip(id, user.id);
  const budget = await setTripBudget(id, user.id, null);
  auditBudgetChanged({ requestId, userId: user.id, trip, currency: null });

  log.info({ tripId: id }, "Trip budget cleared");
  return { budget };
});
