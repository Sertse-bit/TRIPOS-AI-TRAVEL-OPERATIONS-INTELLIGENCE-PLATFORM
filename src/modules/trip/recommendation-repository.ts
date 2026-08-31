import { pool } from "@/infrastructure/db";

export interface RecommendationRecord {
  id: string;
  tripId: string;
  riskAssessmentId: string | null;
  decision: string;
  evidence: Record<string, unknown>;
  reasoningSummary: string;
  recommendationText: string;
  confidence: number;
  status: "PENDING" | "ACKNOWLEDGED" | "DISMISSED";
  createdAt: Date;
}

function mapRow(row: {
  id: string;
  trip_id: string;
  risk_assessment_id: string | null;
  decision: string;
  evidence: Record<string, unknown>;
  reasoning_summary: string;
  recommendation_text: string;
  confidence: string;
  status: "PENDING" | "ACKNOWLEDGED" | "DISMISSED";
  created_at: Date;
}): RecommendationRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    riskAssessmentId: row.risk_assessment_id,
    decision: row.decision,
    evidence: row.evidence,
    reasoningSummary: row.reasoning_summary,
    recommendationText: row.recommendation_text,
    confidence: Number(row.confidence),
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * riskAssessmentId is deliberately not accepted here yet -- Phase 16
 * doesn't exist, so there's nothing real to reference. When it lands,
 * this stays additive (an optional param), not a breaking change.
 */
export async function createRecommendation(input: {
  tripId: string;
  decision: string;
  evidence: Record<string, unknown>;
  reasoningSummary: string;
  recommendationText: string;
  confidence: number;
}): Promise<RecommendationRecord> {
  const result = await pool.query(
    `INSERT INTO recommendations (trip_id, decision, evidence, reasoning_summary, recommendation_text, confidence)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, trip_id, risk_assessment_id, decision, evidence, reasoning_summary, recommendation_text, confidence, status, created_at`,
    [
      input.tripId,
      input.decision,
      JSON.stringify(input.evidence),
      input.reasoningSummary,
      input.recommendationText,
      input.confidence,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findRecommendationsByTripId(tripId: string): Promise<RecommendationRecord[]> {
  const result = await pool.query(
    `SELECT id, trip_id, risk_assessment_id, decision, evidence, reasoning_summary, recommendation_text, confidence, status, created_at
     FROM recommendations WHERE trip_id = $1 ORDER BY created_at DESC`,
    [tripId],
  );
  return result.rows.map(mapRow);
}
