import { z } from "zod";
import { defineTool } from "@/ai/tools/types";
import { getTrip, getTripDocuments } from "@/modules/trip/trip-service";

export interface TripKnowledgeMatch {
  documentId: string;
  filename: string;
  excerpt: string;
  relevance: number;
}

/**
 * Phase 15 (RAG System) doesn't exist yet -- there is no embedding
 * pipeline, no document_chunks data to search. Rather than skip this
 * tool entirely (it's explicitly in the brief's Phase 8 list) or fake a
 * result, this returns an honest, structured "not available yet" answer
 * distinguishing two real cases: no documents attached at all, versus
 * documents attached but not yet processed into a searchable form.
 *
 * The output shape (`matches: TripKnowledgeMatch[]`) is what Phase 15
 * fills in for real — agents calling this tool won't need to change
 * when that happens, only this function's body will.
 */
export const searchTripKnowledgeTool = defineTool({
  name: "search_trip_knowledge",
  description:
    "Search the content of documents uploaded to a trip (e.g. booking confirmations, itineraries) for an answer to a question. Only returns results for documents that have finished processing -- if this returns no matches, say so plainly rather than guessing at an answer.",
  inputSchema: z.object({
    tripId: z.string().uuid(),
    query: z.string().trim().min(1).max(500),
  }),
  execute: async (input, context) => {
    await getTrip(input.tripId, context.userId);
    const documents = await getTripDocuments(input.tripId, context.userId);

    if (documents.length === 0) {
      return {
        query: input.query,
        matches: [] as TripKnowledgeMatch[],
        status: "no_documents" as const,
        message: "No documents have been uploaded to this trip yet.",
      };
    }

    // Every document is necessarily unprocessed right now -- Phase 14's
    // extraction/chunking pipeline doesn't exist yet, so nothing has
    // ever advanced past UPLOADED. This isn't a guess; it's checking
    // the real column Phase 3/7 already defined for exactly this.
    const readyCount = documents.filter((d) => d.status === "READY").length;

    return {
      query: input.query,
      matches: [] as TripKnowledgeMatch[],
      status: "not_yet_processed" as const,
      message:
        readyCount === 0
          ? "Documents are attached to this trip but none have finished processing yet."
          : "Document search is not yet implemented.",
    };
  },
});
