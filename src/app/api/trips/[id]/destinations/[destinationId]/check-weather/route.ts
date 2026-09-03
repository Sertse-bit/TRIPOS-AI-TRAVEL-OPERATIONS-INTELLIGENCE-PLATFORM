import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { runWeatherAgentForUser } from "@/ai/agents/weather-agent";

export const POST = withApiHandler(async (_requestId, log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id: tripId, destinationId } = await context.params;

  const result = await runWeatherAgentForUser(tripId, destinationId, user.id);
  log.info({ tripId, destinationId, significant: result.significant }, "Weather checked");
  return result;
});
