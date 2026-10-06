import { z } from "zod";
import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { getTripWatch, upsertTripWatch } from "@/modules/monitor/watch-service";
import { getTrip } from "@/modules/trip/trip-service";
import { auditWatchUpserted } from "@/modules/audit/route-audit";

/**
 * Trip Watch preferences for one trip (Phase 19).
 *
 * GET reads the watch (null when nobody is watching this trip yet), PUT
 * creates or updates it. PUT rather than PATCH because the first call
 * for an unwatched trip genuinely creates the resource — the same
 * semantics a PATCH would silently pretend to have.
 */
export const GET = withApiHandler(async (_requestId, _log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  return { watch: await getTripWatch(id, user.id) };
});

/**
 * Bounds are validated in the service, not here, so the 5..1440 rule has
 * exactly one definition and the same message whether it is reached
 * through this route, the service directly, or a future caller.
 */
const bodySchema = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().optional(),
  alertMinSeverity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
});

export const PUT = withApiHandler(async (requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  const body = bodySchema.parse(await request.json());

  const watch = await upsertTripWatch(id, user.id, body);
  const trip = await getTrip(id, user.id);
  auditWatchUpserted({ requestId, userId: user.id, trip, watch });

  log.info(
    {
      tripId: id,
      enabled: watch.enabled,
      intervalMinutes: watch.intervalMinutes,
      alertMinSeverity: watch.alertMinSeverity,
      nextRunAt: watch.nextRunAt,
    },
    "Trip watch updated",
  );
  return { watch };
});
