import { z } from "zod";
import { defineTool } from "@/ai/tools/types";
import { getTrip } from "@/modules/trip/trip-service";
import { searchTripDocuments } from "@/modules/trip/rag-service";

export interface TripKnowledgeMatch {
  documentId: string;
  filename: string;
  excerpt: string;
  relevance: number;
}

/**
 * Real retrieval over this trip's indexed documents (Phase 15's
 * pgvector-backed search). This tool used to return a hardcoded
 * "not yet implemented" answer because Phase 15 didn't exist when it was
 * written — it does now, so it calls the actual search instead.
 *
 * What it deliberately does NOT do is hide how the ranking was done.
 * `embeddingProvider` and `semantic` are passed straight through so the
 * model (and ultimately the traveler) can see whether a match came from
 * real semantic embeddings or from the local lexical fallback. An agent
 * that reports a lexical hit as though it were an embedding match would
 * be exactly the kind of invented capability this project refuses.
 */
export const searchTripKnowledgeTool = defineTool({
  name: "search_trip_knowledge",
  description:
    "Search the content of documents uploaded to a trip (e.g. booking confirmations, itineraries) for an answer to a question. Only returns results for documents that have been processed and indexed -- if this returns no matches, say so plainly rather than guessing at an answer.",
  inputSchema: z.object({
    tripId: z.string().uuid(),
    query: z.string().trim().min(1).max(500),
  }),
  execute: async (input, context) => {
    await getTrip(input.tripId, context.userId);
    const result = await searchTripDocuments(input.tripId, context.userId, input.query);

    const matches: TripKnowledgeMatch[] = result.chunks.map((chunk) => ({
      documentId: chunk.documentId,
      filename: chunk.originalFilename,
      excerpt: chunk.content,
      relevance: chunk.similarity,
    }));

    return {
      query: result.query,
      matches,
      // Surfaced so the caller can qualify its claims. With the local
      // fallback these are lexical matches, not semantic ones.
      embeddingProvider: result.embeddingProvider,
      semantic: result.semantic,
      noEvidence: result.noEvidence,
    };
  },
});
