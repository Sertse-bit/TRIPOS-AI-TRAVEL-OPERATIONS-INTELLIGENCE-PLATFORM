import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { runPlanningAgentForUser } from "@/ai/agents/planning-agent";
import { auditAgentDelivery } from "@/modules/audit/route-audit";

/**
 * Generate a day-by-day plan for this trip with the Planning Agent
 * (Phase 20). The agent's output is grounded against the trip's real
 * dates and destinations before anything is persisted (see
 * ai/agents/planning-agent.ts), and replaces only the trip's previous
 * AI-generated items — traveler-written items are untouched.
 *
 * With no Anthropic key configured this returns a clean 502 naming the
 * missing key, rather than a fabricated plan. That is the honest
 * behaviour, not a failure mode to work around.
 */
export const POST = withApiHandler(async (requestId, log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;

  const result = await runPlanningAgentForUser(id, user.id);
  auditAgentDelivery({
    requestId,
    userId: user.id,
    agentName: "planning_agent",
    tripId: id,
    action: "itinerary.plan_generated",
    entityType: "trip",
    entityId: id,
    metadata: {
      planRunId: result.planRunId,
      itemsCreated: result.itemsCreated,
      days: result.days.length,
      overBudget: result.budget.converted?.overBudget ?? null,
    },
  });

  log.info(
    {
      tripId: id,
      planRunId: result.planRunId,
      itemsCreated: result.itemsCreated,
      aiItemsReplaced: result.aiItemsReplaced,
      days: result.days.length,
      overBudget: result.budget.converted?.overBudget ?? null,
    },
    "Itinerary plan generated",
  );
  return result;
});
