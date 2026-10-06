import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { indexTripDocument } from "@/modules/trip/rag-service";
import { getTrip } from "@/modules/trip/trip-service";
import { auditDocumentReindexed } from "@/modules/audit/route-audit";

/**
 * Re-indexes one document on demand: chunks its extracted text and
 * stores one vector per chunk. Idempotent, and the recovery path when
 * automatic indexing at upload time failed or the embedding model
 * changed.
 */
export const POST = withApiHandler(async (requestId, log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id, documentId } = await context.params;

  const result = await indexTripDocument(id, user.id, documentId);
  const trip = await getTrip(id, user.id);
  auditDocumentReindexed({
    requestId,
    userId: user.id,
    trip,
    documentId,
    chunks: result.chunks,
    embeddingProvider: result.embeddingProvider,
    semantic: result.semantic,
  });
  log.info(
    {
      tripId: id,
      documentId,
      chunks: result.chunks,
      embeddingProvider: result.embeddingProvider,
      semantic: result.semantic,
    },
    "Trip document indexed",
  );
  return result;
});
