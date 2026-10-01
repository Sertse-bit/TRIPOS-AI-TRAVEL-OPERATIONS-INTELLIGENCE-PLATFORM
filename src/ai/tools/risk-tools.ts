import { z } from "zod";
import { defineTool } from "@/ai/tools/types";
import { getLatestTripRisk, listTripRiskAssessments } from "@/modules/risk/risk-service";

/**
 * Read-only access to the deterministic risk assessment (Phase 16).
 *
 * The important property: this tool returns the *stored* assessment, not
 * a freshly recomputed one, and never asks the model to produce a score.
 * Phase 16's scoring model is a pure function precisely so no LLM can
 * influence the number; an agent's job is to explain that number, and
 * the only way to do it honestly is to hand it the real factors and the
 * real evidence those factors were computed from.
 */
export const getTripRiskTool = defineTool({
  name: "get_trip_risk",
  description:
    "Get this trip's computed risk assessment: the score, its severity, every weighted factor with its points and the real values behind it, and the recorded evidence. The score is calculated deterministically from stored data -- do not recompute it, do not estimate it, and do not contradict it. If no assessment exists yet, the trip must be assessed first.",
  inputSchema: z.object({
    tripId: z.string().uuid(),
  }),
  execute: async (input, context) => {
    const latest = await getLatestTripRisk(input.tripId, context.userId);
    if (!latest) {
      return {
        assessed: false as const,
        message:
          "This trip has no risk assessment yet. One must be generated before it can be explained.",
      };
    }

    return {
      assessed: true as const,
      assessment: {
        id: latest.id,
        riskScore: latest.riskScore,
        severity: latest.severity,
        confidence: latest.confidence,
        generatedAt: latest.generatedAt,
        factors: latest.factors,
        evidence: latest.evidence,
      },
    };
  },
});

/**
 * Assessment history, so an agent can say whether risk is rising or
 * falling rather than describing a single point in time as if it were
 * the whole trend.
 */
export const getTripRiskHistoryTool = defineTool({
  name: "get_trip_risk_history",
  description:
    "List this trip's risk assessments over time, newest first, with score and severity only. Use this to tell whether risk is improving or worsening. Do not use it as a substitute for get_trip_risk's factor detail.",
  inputSchema: z.object({
    tripId: z.string().uuid(),
  }),
  execute: async (input, context) => {
    const assessments = await listTripRiskAssessments(input.tripId, context.userId);
    return {
      assessments: assessments.map((assessment) => ({
        id: assessment.id,
        riskScore: assessment.riskScore,
        severity: assessment.severity,
        confidence: assessment.confidence,
        generatedAt: assessment.generatedAt,
      })),
    };
  },
});
