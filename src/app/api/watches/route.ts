import { withApiHandler } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { countDueWatches, listTripWatches, runDueWatches } from "@/modules/monitor/watch-service";

/**
 * The Trip Watch console (Phase 19): every watch the caller owns, and a
 * sweep over the ones that are due.
 *
 * The sweep is scoped to the authenticated user on purpose. A global
 * sweep would make one click spend every other traveler's provider
 * quota, so the unscoped variant exists only as
 * `runDueWatches()`'s ownerless form for a real scheduler to call
 * server-side — deliberately not reachable over HTTP without a session.
 */
export const GET = withApiHandler(async () => {
  const user = await requireAuth();
  const [watches, due] = await Promise.all([
    listTripWatches(user.id),
    countDueWatches({ ownerId: user.id }),
  ]);
  return { watches, due };
});

export const POST = withApiHandler(async (_requestId, log) => {
  const user = await requireAuth();
  const result = await runDueWatches({ ownerId: user.id });

  log.info(
    {
      passes: result.passes.length,
      alertsRaised: result.alertsRaised,
      failed: result.failed,
      finished: result.finished,
      stillDue: result.stillDue,
    },
    "Trip Watch sweep completed",
  );
  return result;
});
