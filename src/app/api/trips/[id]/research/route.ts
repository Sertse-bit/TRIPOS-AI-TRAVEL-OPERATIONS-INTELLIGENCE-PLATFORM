import { z } from "zod";
import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { runResearchAgentForUser } from "@/ai/agents/research-agent";

const bodySchema = z.object({
  question: z.string().trim().min(1).max(500),
});

export const POST = withApiHandler(async (_requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id: tripId } = await context.params;
  const { question } = bodySchema.parse(await request.json());

  const result = await runResearchAgentForUser(tripId, user.id, question);
  log.info({ tripId, hasEvidence: result.hasEvidence }, "Research question answered");
  return result;
});
