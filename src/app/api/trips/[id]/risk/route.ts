import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { assessTripRisk, listTripRiskAssessments } from "@/modules/risk/risk-service";
import { auditAgentDelivery } from "@/modules/audit/route-audit";

/**
 * Computes and stores a fresh deterministic risk assessment for a trip
 * the caller owns. POST (not GET) because this writes a row and a
 * trip_events entry — the score is a new point in the trip's history,
 * not a side-effect-free read.
 */
export const POST = withApiHandler(async (requestId, log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;

  const result = await assessTripRisk(id, user.id);
  auditAgentDelivery({
    requestId,
    userId: user.id,
    agentName: "risk_agent",
    tripId: id,
    action: "risk.assessed",
    entityType: "trip",
    entityId: id,
    metadata: {
      riskScore: result.assessment.riskScore,
      severity: result.assessment.severity,
      confidence: result.confidence,
    },
  });

  log.info(
    {
      tripId: id,
      riskScore: result.assessment.riskScore,
      severity: result.assessment.severity,
      confidence: result.confidence,
    },
    "Risk assessment generated",
  );
  return result;
});

/**
 * Assessment history, newest first. An empty array means none has been
 * generated yet — it is not filled in with a default score.
 */
export const GET = withApiHandler(async (_requestId, _log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  return listTripRiskAssessments(id, user.id);
});
