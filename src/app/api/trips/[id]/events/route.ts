import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { getTripEventHistory } from "@/modules/trip/trip-service";

export const GET = withApiHandler(async (_requestId, _log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  const events = await getTripEventHistory(id, user.id);
  return { events };
});
