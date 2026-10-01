import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { monitorTrip } from "@/modules/monitor/monitor-service";

/**
 * Runs one monitoring pass over a trip the caller owns: checks every
 * flight and destination against its provider, recomputes the risk
 * score, and raises at most one alert if the risk genuinely changed.
 *
 * POST because a pass writes snapshots, an assessment, and possibly a
 * notification — it is not a side-effect-free read. A second call with
 * nothing changed is a genuine no-op, which is what makes it safe for a
 * scheduler to call on a timer.
 */
export const POST = withApiHandler(async (_requestId, log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;

  const result = await monitorTrip(id, user.id);

  log.info(
    {
      tripId: id,
      flightsChecked: result.checkedFlights.length,
      flightsChanged: result.flightsChanged,
      skipped: result.checkedFlights.filter((f) => f.skipped).length,
      riskScore: result.riskChange?.riskScore,
      severity: result.riskChange?.severity,
      alertRaised: result.alert !== null,
      alertSuppressed: result.alertSuppressed,
    },
    "Trip monitor pass completed",
  );
  return result;
});
