import {
  getTrip,
  createTripRecommendation,
  getTripRecommendations,
} from "@/modules/trip/trip-service";
import { explainTripRisk, type RiskExplanationResult } from "@/ai/agents/risk-agent";

/**
 * Recommendation Service — Phase 17.
 *
 * Sits between the Risk Agent (which explains a stored assessment in
 * prose) and the `recommendations` table (which records the four-part
 * explainable-AI structure). Its whole job is to make sure the two
 * halves are linked honestly:
 *
 *  - the recommendation is written against the *same* assessment the
 *    explanation was generated from, not a plausible-looking one;
 *  - the evidence stored is the agent's evidence plus the assessment
 *    reference, so the row is auditable without re-running anything;
 *  - the score and severity stored alongside are the deterministic
 *    ones, never anything the model said.
 *
 * The model writes prose. It does not write numbers.
 */

export interface PersistedRecommendation {
  recommendation: {
    id: string;
    tripId: string;
    riskAssessmentId: string | null;
    decision: string;
    evidence: Record<string, unknown>;
    reasoningSummary: string;
    recommendationText: string;
    confidence: number;
    status: string;
    createdAt: Date;
  };
  /** The deterministic values, echoed so a caller never has to re-read them. */
  riskScore: number;
  severity: string;
  assessmentConfidence: number;
}

export async function generateTripRecommendation(
  tripId: string,
  userId: string,
): Promise<PersistedRecommendation> {
  const explanation: RiskExplanationResult = await explainTripRisk(tripId, userId);

  const recommendation = await createTripRecommendation(tripId, userId, {
    decision: explanation.decision,
    evidence: {
      // The agent's own citations, plus the deterministic context they
      // were checked against. Both halves are stored: the prose claim
      // and the score it was allowed to make claims about.
      factorsCited: explanation.evidence,
      riskAssessmentId: explanation.riskAssessmentId,
      riskScore: explanation.riskScore,
      severity: explanation.severity,
      assessmentConfidence: explanation.assessmentConfidence,
      assessmentGeneratedAt: explanation.generatedAt.toISOString(),
    },
    reasoningSummary: explanation.reasoningSummary,
    recommendationText: explanation.recommendationText,
    confidence: explanation.confidence,
    riskAssessmentId: explanation.riskAssessmentId,
  });

  return {
    recommendation,
    riskScore: explanation.riskScore,
    severity: explanation.severity,
    assessmentConfidence: explanation.assessmentConfidence,
  };
}

export async function listTripRecommendations(tripId: string, userId: string) {
  await getTrip(tripId, userId);
  return getTripRecommendations(tripId, userId);
}
