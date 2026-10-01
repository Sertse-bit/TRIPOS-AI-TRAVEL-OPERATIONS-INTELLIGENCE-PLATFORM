import { z } from "zod";
import { defineAgent } from "@/ai/agents/types";
import { runAgent } from "@/ai/orchestrator";
import { getTrip } from "@/modules/trip/trip-service";
import { getLatestTripRisk } from "@/modules/risk/risk-service";
import { providerAvailability } from "@/config/env";
import { generateRequestId } from "@/shared/api-response";
import { ProviderError, ValidationError } from "@/shared/errors";

/**
 * Risk Agent — Phase 17, Explainable AI.
 *
 * This is the one place a model touches risk, and its job is narrow on
 * purpose. Phase 16's score is deterministic and cannot be argued with;
 * this agent explains that score in language a traveler can act on, and
 * writes the Decision / Evidence / Reasoning / Recommendation /
 * Confidence structure the `recommendations` table was designed for.
 *
 * **It never produces or adjusts a number.** The score, its severity,
 * and every factor come from the stored assessment via `get_trip_risk`.
 * The only things generated here are prose and a confidence figure, and
 * both are bounded by checks in this file rather than by trusting the
 * prompt (see `clampConfidenceToAssessment` and `assertGroundedInFactors`).
 */

/**
 * `factor` must name a real factor from the stored assessment. That
 * constraint is what makes the evidence checkable: an agent cannot cite
 * a factor that doesn't exist, so its explanation can't drift away from
 * the score it's explaining.
 */
export const riskExplanationSchema = z.object({
  decision: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("The situation in one sentence, in the assessor's own severity terms."),
  evidence: z
    .array(
      z.object({
        factor: z
          .string()
          .describe(
            "The risk factor this observation comes from, exactly as named by get_trip_risk.",
          ),
        observation: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .describe("The specific recorded value(s) behind this point, e.g. a delay in minutes."),
      }),
    )
    .describe("Every observation traced to a factor of the stored assessment."),
  reasoningSummary: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe("Why these observations lead to this decision and recommendation."),
  recommendationText: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe("The concrete action for the traveler."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How confident you are in the explanation itself, not in the score."),
});

export type RiskExplanation = z.infer<typeof riskExplanationSchema>;

export const riskAgent = defineAgent({
  name: "risk_agent",
  role: `You explain a travel risk assessment that has ALREADY been calculated. You do not calculate risk.

Rules, no exceptions:
- Call get_trip_risk first. Its score, severity, and factors are the ground truth for your explanation. Never recompute, estimate, or contradict the score or severity it reports.
- Every entry in your evidence array must name a factor that get_trip_risk actually returned, and quote the real values it recorded (delay minutes, wind speed, departure time). Do not invent a factor, a number, or a detail the assessment does not contain.
- If the assessment reports that some factors had no data, say so plainly. Do not fill a data gap with speculation, and do not describe a factor that was never scored as if it were reassuring.
- Your reasoning must follow from the cited evidence. If the evidence is weak, the reasoning and recommendation should be correspondingly hedged.
- The recommendation must be something the traveler can actually act on or explicitly decide to ignore. Do not manufacture urgency that the score does not support -- a LOW-severity trip does not need an alarming recommendation.
- Do not call create_recommendation or create_alert. This run produces the explanation only; persisting it is the caller's job.`,
  allowedTools: ["get_trip_risk", "get_trip_risk_history", "get_trip"],
  outputSchema: riskExplanationSchema,
});

/**
 * A factor entry as the scoring model wrote it. Parsed defensively
 * because it comes back from a JSONB column: a row written by an older
 * or hand-edited version must not crash the agent.
 */
interface StoredFactor {
  key?: unknown;
  label?: unknown;
  points?: unknown;
  weight?: unknown;
  detail?: unknown;
  dataAvailable?: unknown;
}

function readFactors(factors: unknown): StoredFactor[] {
  if (!Array.isArray(factors)) return [];
  return factors.filter(
    (entry): entry is StoredFactor => typeof entry === "object" && entry !== null,
  );
}

/**
 * The model's confidence cannot exceed the assessment's own confidence.
 *
 * Phase 16 defines confidence as the share of factors that actually had
 * real data behind them. An explanation built on an assessment where
 * only half the factors were scorable cannot honestly be more confident
 * than that half allows — so the ceiling is applied here, in code,
 * rather than being left to a prompt instruction the model could ignore.
 */
export function clampConfidenceToAssessment(
  modelConfidence: number,
  assessmentConfidence: number,
): number {
  return Math.max(0, Math.min(modelConfidence, assessmentConfidence));
}

/**
 * Every cited factor must be one the assessment actually recorded.
 * Returns the offending entries so the error can name them precisely
 * rather than failing with a generic "invalid output".
 */
export function findUngroundedEvidence(
  evidence: Array<{ factor: string }>,
  factors: unknown,
): string[] {
  // Defensive on purpose: this reads a JSONB column, so it can hold
  // anything a previous version (or a hand edit) left behind. Failing
  // closed — a malformed factors array grounds *nothing*, so the
  // explanation is rejected rather than accepted against factors we
  // could not actually verify.
  const known = new Set(
    readFactors(factors)
      .map((factor) => (typeof factor.key === "string" ? factor.key : null))
      .filter((key): key is string => key !== null),
  );
  return evidence.map((item) => item.factor).filter((key) => !known.has(key));
}

/**
 * Checks the explanation against the stored assessment. Throws rather
 * than returning a quietly-wrong explanation to a traveler.
 *
 * `recommendationRiskAssessmentId` is deliberately absent from the
 * agent's output: which assessment an explanation belongs to is decided
 * by the caller, from the row it actually read, never by the model.
 */
export function assertGroundedInFactors(explanation: RiskExplanation, factors: unknown): void {
  const ungrounded = findUngroundedEvidence(explanation.evidence, factors);
  if (ungrounded.length > 0) {
    throw new ValidationError(
      `The risk explanation cited factors that are not part of the stored assessment: ${[
        ...new Set(ungrounded),
      ].join(
        ", ",
      )}. Rejecting rather than passing along an explanation that isn't grounded in the score.`,
    );
  }
}

export interface RiskExplanationResult extends RiskExplanation {
  riskAssessmentId: string;
  riskScore: number;
  severity: string;
  /** The assessment's own confidence, as stored. */
  assessmentConfidence: number;
  generatedAt: Date;
}

/**
 * User-facing entry point. Ownership is checked up front so an
 * unauthorized request fails cleanly before any model call is made.
 */
export async function explainTripRisk(
  tripId: string,
  userId: string,
): Promise<RiskExplanationResult> {
  await getTrip(tripId, userId);

  // Refuse clearly rather than returning a generic upstream failure. An
  // LLM-backed explanation has no honest mock adapter -- inventing one
  // would be fabricating the exact prose this phase exists to ground in
  // real evidence -- so an unconfigured key is reported as what it is.
  if (!providerAvailability.anthropic) {
    throw new ProviderError(
      "risk_agent",
      "Risk explanations require an Anthropic API key, which isn't configured. The risk score itself is unaffected and remains fully available -- only the natural-language explanation needs this key.",
    );
  }

  const assessment = await getLatestTripRisk(tripId, userId);
  if (!assessment) {
    throw new ValidationError(
      "This trip has no risk assessment yet. Generate one before asking for an explanation of it.",
    );
  }

  const factors = readFactors(assessment.factors);
  const requestId = generateRequestId();

  const result = await runAgent(
    riskAgent,
    "Explain this trip's current risk assessment to the traveler: what the situation is, the recorded evidence behind it, why it leads to that reading, and what they should do about it.",
    { userId, requestId },
  );

  if (!result.success) {
    throw new ProviderError(
      "risk_agent",
      `The risk agent could not complete this request: ${result.reason}.`,
    );
  }

  const explanation = result.data;

  // Code-level grounding check. The prompt asks for this; this enforces it.
  assertGroundedInFactors(explanation, factors);

  return {
    ...explanation,
    // Clamped in code, not merely requested in the prompt.
    confidence: clampConfidenceToAssessment(explanation.confidence, assessment.confidence),
    // Supplied by this function from the row it actually read -- never
    // by the model.
    riskAssessmentId: assessment.id,
    riskScore: assessment.riskScore,
    severity: assessment.severity,
    assessmentConfidence: assessment.confidence,
    generatedAt: assessment.generatedAt,
  };
}
