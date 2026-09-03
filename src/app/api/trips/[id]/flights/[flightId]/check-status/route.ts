import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { runFlightAgentForUser } from "@/ai/agents/flight-agent";

export const POST = withApiHandler(async (_requestId, log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id: tripId, flightId } = await context.params;

  const result = await runFlightAgentForUser(tripId, flightId, user.id);
  log.info(
    { tripId, flightId, currentStatus: result.currentStatus, changed: result.changed },
    "Flight status checked",
  );
  return result;
});
