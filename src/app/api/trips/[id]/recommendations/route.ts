import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import {
  generateTripRecommendation,
  listTripRecommendations,
} from "@/modules/risk/recommendation-service";
import { explainTripRisk } from "@/ai/agents/risk-agent";

/**
 * Generates an explanation of the trip's stored risk assessment and
 * persists it as a recommendation linked to that assessment.
 *
 * POST because this writes a `recommendations` row and a
 * RECOMMENDATION_CREATED event. The deterministic score itself is not
 * touched — see `/api/trips/[id]/risk`, which computes it.
 */
export const POST = withApiHandler(async (_requestId, log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;

  const result = await generateTripRecommendation(id, user.id);

  log.info(
    {
      tripId: id,
      recommendationId: result.recommendation.id,
      riskAssessmentId: result.recommendation.riskAssessmentId,
      severity: result.severity,
    },
    "Recommendation generated",
  );
  return result;
});

/** Stored recommendations, newest first. */
export const GET = withApiHandler(async (_requestId, _log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  return listTripRecommendations(id, user.id);
});

/**
 * Preview-only explanation: runs the agent and returns what it said
 * WITHOUT persisting anything, so a traveler can read an assessment
 * before deciding to record a recommendation against it.
 */
export const PATCH = withApiHandler(async (_requestId, log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;

  const explanation = await explainTripRisk(id, user.id);

  log.info(
    { tripId: id, riskAssessmentId: explanation.riskAssessmentId },
    "Risk explanation generated (not persisted)",
  );
  return explanation;
});
