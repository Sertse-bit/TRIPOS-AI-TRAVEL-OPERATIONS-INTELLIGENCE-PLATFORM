import { z } from "zod";
import { defineTool } from "@/ai/tools/types";
import { getTrip } from "@/modules/trip/trip-service";
import { createRecommendation } from "@/modules/trip/recommendation-repository";
import { createNotification } from "@/modules/trip/notification-repository";
import { recordTripEvent } from "@/modules/trip/trip-event-repository";

/**
 * Input schema mirrors Phase 17's explainable-AI structure exactly
 * (Decision / Evidence / Reasoning / Recommendation / Confidence) --
 * this tool is the concrete write path that structure will use once
 * agents exist to call it.
 *
 * confidence is bounded to [0,1] by the schema itself, not left to the
 * caller's discretion -- a model returning 1.5 or -3 gets a validation
 * error, not a corrupted row.
 */
export const createRecommendationTool = defineTool({
  name: "create_recommendation",
  description:
    "Record a recommendation for the traveler, with the evidence and reasoning behind it. Use this only when you have concrete evidence (from other tool calls) supporting the recommendation -- never to record a guess.",
  inputSchema: z.object({
    tripId: z.string().uuid(),
    decision: z.string().trim().min(1).max(500).describe("What happened, in one sentence."),
    evidence: z
      .record(z.string(), z.unknown())
      .describe("The concrete data supporting this, e.g. tool results."),
    reasoningSummary: z.string().trim().min(1).max(1000),
    recommendationText: z.string().trim().min(1).max(1000).describe("What the traveler should do."),
    confidence: z.number().min(0).max(1),
  }),
  execute: async (input, context) => {
    await getTrip(input.tripId, context.userId);

    const recommendation = await createRecommendation({
      tripId: input.tripId,
      decision: input.decision,
      evidence: input.evidence,
      reasoningSummary: input.reasoningSummary,
      recommendationText: input.recommendationText,
      confidence: input.confidence,
    });

    await recordTripEvent({
      tripId: input.tripId,
      eventType: "RECOMMENDATION_CREATED",
      entityType: "recommendation",
      entityId: recommendation.id,
      metadata: { confidence: input.confidence },
    });

    return { recommendation };
  },
});

export const createAlertTool = defineTool({
  name: "create_alert",
  description:
    "Send the traveler a notification about something they should know. Use sparingly -- only for genuinely actionable or important information, not routine status updates. Intelligent throttling for repeated automated checks is handled elsewhere; this tool always creates exactly one notification when called.",
  inputSchema: z.object({
    tripId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(1000),
  }),
  execute: async (input, context) => {
    const trip = await getTrip(input.tripId, context.userId);

    const notification = await createNotification({
      userId: trip.userId,
      title: input.title,
      body: input.body,
    });

    await recordTripEvent({
      tripId: input.tripId,
      eventType: "NOTIFICATION_REQUIRED",
      entityType: "notification",
      entityId: notification.id,
      metadata: { title: input.title },
    });

    return { notification };
  },
});
