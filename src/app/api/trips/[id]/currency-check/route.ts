import { z } from "zod";
import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { runCurrencyAgentForUser } from "@/ai/agents/currency-agent";

const bodySchema = z.object({
  baseCurrency: z.string().trim().length(3).toUpperCase(),
  targetCurrency: z.string().trim().length(3).toUpperCase(),
  amount: z.number().positive().optional(),
});

export const POST = withApiHandler(async (_requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id: tripId } = await context.params;
  const body = await request.json();
  const { baseCurrency, targetCurrency, amount } = bodySchema.parse(body);

  const result = await runCurrencyAgentForUser(
    tripId,
    user.id,
    baseCurrency,
    targetCurrency,
    amount,
  );
  log.info({ tripId, baseCurrency, targetCurrency }, "Currency rate checked");
  return result;
});
