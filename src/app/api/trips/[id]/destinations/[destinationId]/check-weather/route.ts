import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { runWeatherAgentForUser } from "@/ai/agents/weather-agent";
import { auditAgentDelivery } from "@/modules/audit/route-audit";

export const POST = withApiHandler(async (requestId, log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id: tripId, destinationId } = await context.params;

  const result = await runWeatherAgentForUser(tripId, destinationId, user.id);
  // A snapshot is only "delivered" when one was actually recorded; a
  // significant-but-duplicate reading wrote nothing and audits nothing.
  if (result.snapshotId) {
    auditAgentDelivery({
      requestId,
      userId: user.id,
      agentName: "weather_agent",
      tripId,
      action: "weather.snapshot_recorded",
      entityType: "destination",
      entityId: destinationId,
      metadata: { significant: result.significant, snapshotId: result.snapshotId },
    });
  }
  log.info({ tripId, destinationId, significant: result.significant }, "Weather checked");
  return result;
});
