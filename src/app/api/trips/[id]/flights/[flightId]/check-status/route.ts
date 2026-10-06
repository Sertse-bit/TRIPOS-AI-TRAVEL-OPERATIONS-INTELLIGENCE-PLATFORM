import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { runFlightAgentForUser } from "@/ai/agents/flight-agent";
import { auditAgentDelivery } from "@/modules/audit/route-audit";

export const POST = withApiHandler(async (requestId, log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id: tripId, flightId } = await context.params;

  const result = await runFlightAgentForUser(tripId, flightId, user.id);
  auditAgentDelivery({
    requestId,
    userId: user.id,
    agentName: "flight_agent",
    tripId,
    action: "flight.status_update",
    entityType: "flight",
    entityId: flightId,
    metadata: { changed: result.changed, currentStatus: result.currentStatus },
  });
  log.info(
    { tripId, flightId, currentStatus: result.currentStatus, changed: result.changed },
    "Flight status checked",
  );
  return result;
});
