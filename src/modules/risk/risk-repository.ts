import { pool } from "@/infrastructure/db";

export type RiskSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface RiskAssessmentRecord {
  id: string;
  tripId: string;
  riskScore: number;
  severity: RiskSeverity;
  factors: unknown;
  evidence: unknown;
  confidence: number;
  generatedAt: Date;
  createdAt: Date;
}

const COLUMNS = `
  id, trip_id, risk_score, severity, factors, evidence, confidence,
  generated_at, created_at
`;

function mapRow(row: {
  id: string;
  trip_id: string;
  risk_score: number;
  severity: RiskSeverity;
  factors: unknown;
  evidence: unknown;
  confidence: string;
  generated_at: Date;
  created_at: Date;
}): RiskAssessmentRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    riskScore: row.risk_score,
    severity: row.severity,
    factors: row.factors,
    evidence: row.evidence,
    // DECIMAL arrives as a string from pg (see the same note in
    // destination-repository.ts) — parsed here, not left implicit.
    confidence: Number(row.confidence),
    generatedAt: row.generated_at,
    createdAt: row.created_at,
  };
}

/**
 * Assessments are append-only, like every other history-shaped table in
 * this project (snapshots, trip_events): a re-assessment inserts a new
 * row rather than overwriting the last one, so "how did this trip's risk
 * evolve" stays answerable.
 *
 * `severity` is passed as `$3::"RiskSeverity"` explicitly — per the
 * AGENTS.md enum-cast rule this parameter position (a bare literal
 * adjacent to jsonb parameters) is exactly where Postgres's type
 * inference has bitten this project before.
 */
export async function createRiskAssessment(input: {
  tripId: string;
  riskScore: number;
  severity: RiskSeverity;
  factors: unknown;
  evidence: unknown;
  confidence: number;
  generatedAt: Date;
}): Promise<RiskAssessmentRecord> {
  const result = await pool.query(
    `INSERT INTO risk_assessments
       (trip_id, risk_score, severity, factors, evidence, confidence, generated_at)
     VALUES ($1, $2, $3::"RiskSeverity", $4::jsonb, $5::jsonb, $6, $7)
     RETURNING ${COLUMNS}`,
    [
      input.tripId,
      input.riskScore,
      input.severity,
      JSON.stringify(input.factors),
      JSON.stringify(input.evidence),
      input.confidence,
      input.generatedAt,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findRiskAssessmentsByTripId(tripId: string): Promise<RiskAssessmentRecord[]> {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM risk_assessments WHERE trip_id = $1 ORDER BY generated_at DESC`,
    [tripId],
  );
  return result.rows.map(mapRow);
}

export async function findLatestRiskAssessmentByTripId(
  tripId: string,
): Promise<RiskAssessmentRecord | null> {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM risk_assessments WHERE trip_id = $1
     ORDER BY generated_at DESC, created_at DESC LIMIT 1`,
    [tripId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}
