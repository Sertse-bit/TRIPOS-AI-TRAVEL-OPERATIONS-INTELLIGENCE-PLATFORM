import { withApiHandler } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { getSystemObservability } from "@/modules/observability/observability-service";

/**
 * GET /api/observability — the Phase 23 panel's data source.
 *
 * Authenticated only. The report is about the deployment, not a user's
 * own trips, so it is not owner-scoped; it exposes provider names,
 * statuses, and infrastructure reachability, and no credentials or key
 * material of any kind.
 */
export const GET = withApiHandler(async (_requestId, log) => {
  await requireAuth();

  const report = await getSystemObservability();
  log.info(
    {
      providers: report.summary.providers,
      reachableInfrastructure: report.infrastructure.filter((check) => check.reachable).length,
    },
    "Observability report generated",
  );
  return report;
});
