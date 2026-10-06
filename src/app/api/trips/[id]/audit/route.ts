import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { getTripAuditTrail } from "@/modules/audit/audit-service";

/**
 * A trip's audit trail (Phase 24). Ownership is enforced inside the
 * service via the trip module's own check, so a stranger's trip is a
 * 404 here exactly as it is on every other trip-scoped route.
 *
 * Query params: ?limit (1–100, default 50), ?offset (default 0),
 * ?actorType=USER|AI_AGENT|SYSTEM (optional filter).
 */
export const GET = withApiHandler(async (_requestId, _log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;

  const params = request.nextUrl.searchParams;
  const limit = params.get("limit") ? Number(params.get("limit")) : undefined;
  const offset = params.get("offset") ? Number(params.get("offset")) : undefined;
  const actorTypeParam = params.get("actorType");
  const actorType =
    actorTypeParam === "USER" || actorTypeParam === "AI_AGENT" || actorTypeParam === "SYSTEM"
      ? actorTypeParam
      : undefined;

  return getTripAuditTrail(id, user.id, { limit, offset, actorType });
});
