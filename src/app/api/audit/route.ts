import { withApiHandler } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { getUserAuditTrail } from "@/modules/audit/audit-service";

/**
 * The signed-in traveler's audit stream across all of their trips
 * (Phase 24). Scope follows the caller's own trips — there is no
 * cross-user audit access and no unscoped variant over HTTP.
 *
 * Query params: ?limit (1–100, default 50), ?offset (default 0).
 */
export const GET = withApiHandler(async (_requestId, _log, request) => {
  const user = await requireAuth();

  const params = request.nextUrl.searchParams;
  const limit = params.get("limit") ? Number(params.get("limit")) : undefined;
  const offset = params.get("offset") ? Number(params.get("offset")) : undefined;

  return getUserAuditTrail(user.id, { limit, offset });
});
