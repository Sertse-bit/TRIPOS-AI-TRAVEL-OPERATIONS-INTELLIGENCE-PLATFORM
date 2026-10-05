import { z } from "zod";
import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { runCommandForUser } from "@/ai/agents/command-agent";

/**
 * POST /api/trips/:id/ask — the path docs/ARCHITECTURE.md Section 8
 * specified in Phase 1 for a command-bar question. One command in, one
 * grounded answer out; the response includes the real tool-call trail
 * the answer was checked against.
 */

const bodySchema = z.object({
  command: z.string().trim().min(1).max(500),
});

export const POST = withApiHandler(async (_requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id: tripId } = await context.params;
  const { command } = bodySchema.parse(await request.json());

  const result = await runCommandForUser(tripId, user.id, command);
  log.info(
    {
      tripId,
      toolCallsUsed: result.toolCallsUsed,
      durationMs: result.durationMs,
      tokensUsed: result.tokensUsed,
    },
    "Trip command answered",
  );
  return result;
});
