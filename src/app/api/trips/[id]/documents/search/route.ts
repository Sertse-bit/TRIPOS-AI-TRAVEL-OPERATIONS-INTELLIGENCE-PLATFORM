import { z } from "zod";
import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { MAX_SEARCH_LIMIT, searchTripDocuments } from "@/modules/trip/rag-service";

const bodySchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
  minSimilarity: z.number().min(-1).max(1).optional(),
});

/**
 * Ranked retrieval over the trip's indexed documents. Returns real stored
 * chunks with the similarity that ranked them, and reports honestly when
 * nothing cleared the floor (`noEvidence`) instead of padding results.
 */
export const POST = withApiHandler(async (_requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;
  const body = bodySchema.parse(await request.json());

  const result = await searchTripDocuments(id, user.id, body.query, {
    limit: body.limit,
    minSimilarity: body.minSimilarity,
  });

  log.info(
    {
      tripId: id,
      hits: result.chunks.length,
      noEvidence: result.noEvidence,
      embeddingProvider: result.embeddingProvider,
      semantic: result.semantic,
    },
    "Trip document search executed",
  );
  return result;
});
