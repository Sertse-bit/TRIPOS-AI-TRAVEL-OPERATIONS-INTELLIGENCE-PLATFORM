import { getEmbeddingProvider } from "@/integrations/embeddings/provider";
import { NotFoundError, ProviderError, ValidationError } from "@/shared/errors";
import { chunkDocumentText } from "@/modules/trip/document-chunking";
import {
  countChunksForTrip,
  findIndexedDocumentIdsForTrip,
  replaceDocumentChunks,
  searchChunksByVector,
} from "@/modules/trip/document-chunk-repository";
import { findDocumentWithText } from "@/modules/trip/document-repository";
import { recordTripEvent } from "@/modules/trip/trip-event-repository";
import { getTrip } from "@/modules/trip/trip-service";

/**
 * Document Service — Phase 15 RAG.
 *
 * Two operations, both scoped to a trip the caller owns:
 *   indexTripDocument()   extracted text -> chunks -> vectors -> pgvector
 *   searchTripDocuments() question -> query vector -> top-k chunks
 *
 * Neither invents an answer. Retrieval returns only real stored chunks,
 * each with the similarity that ranked it, and every result carries the
 * embedding provider's name plus whether it is actually semantic — so a
 * caller can never present a lexical match as if it were an embedding
 * model's understanding.
 */

export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 20;

/**
 * A light floor, not a relevance judgement: it drops orthogonal matches
 * so callers aren't handed noise, while leaving borderline-but-genuinely
 * related chunks in. Callers can override it per query.
 */
export const DEFAULT_MIN_SIMILARITY = 0.1;

export interface IndexTripDocumentResult {
  documentId: string;
  originalFilename: string;
  chunks: number;
  charactersIndexed: number;
  estimatedTokens: number;
  embeddingProvider: string;
  /** False means lexical similarity, not semantic — see the provider. */
  semantic: boolean;
}

export interface RetrievedChunk {
  documentId: string;
  originalFilename: string;
  chunkIndex: number;
  content: string;
  similarity: number;
  tokenCount: number | null;
}

export interface SearchTripDocumentsResult {
  query: string;
  chunks: RetrievedChunk[];
  minSimilarity: number;
  embeddingProvider: string;
  semantic: boolean;
  /** True when nothing cleared the similarity floor. */
  noEvidence: boolean;
}

/**
 * Chunks a document's extracted text and stores one vector per chunk.
 * Re-indexing replaces the previous chunks, so this is safe to call again
 * after a model or chunking-parameter change.
 */
export async function indexTripDocument(
  tripId: string,
  userId: string,
  documentId: string,
): Promise<IndexTripDocumentResult> {
  await getTrip(tripId, userId);

  const document = await findDocumentWithText(tripId, documentId);
  if (!document) {
    throw new NotFoundError("TripDocument", documentId);
  }

  const text = document.extractedText?.trim() ?? "";
  if (document.status !== "READY" || text.length === 0) {
    throw new ValidationError(
      "This document has no extracted text to index. Only documents that finished extraction can be indexed.",
    );
  }

  const drafts = chunkDocumentText(text);
  if (drafts.length === 0) {
    throw new ValidationError("Extracted text was too short to produce any indexable chunks.");
  }

  const provider = getEmbeddingProvider();
  const embeddings = await provider.embed(
    drafts.map((draft) => draft.content),
    "document",
  );

  // Defensive: a short embedding list would attach vector i+1 to chunk i.
  if (embeddings.length !== drafts.length) {
    throw new ProviderError(
      provider.providerName,
      `Embedding provider returned ${embeddings.length} vectors for ${drafts.length} chunks.`,
    );
  }

  await replaceDocumentChunks(
    documentId,
    drafts.map((draft, index) => ({
      chunkIndex: draft.index,
      content: draft.content,
      tokenCount: draft.tokenCount,
      embedding: embeddings[index],
    })),
  );

  const estimatedTokens = drafts.reduce((total, draft) => total + draft.tokenCount, 0);

  await recordTripEvent({
    tripId,
    eventType: "DOCUMENT_INDEXED",
    entityType: "trip_document",
    entityId: documentId,
    metadata: {
      chunks: drafts.length,
      characters: text.length,
      embeddingProvider: provider.providerName,
      semantic: provider.semantic,
    },
  });

  return {
    documentId,
    originalFilename: document.originalFilename,
    chunks: drafts.length,
    charactersIndexed: text.length,
    estimatedTokens,
    embeddingProvider: provider.providerName,
    semantic: provider.semantic,
  };
}

/**
 * Ranked retrieval over this trip's indexed documents. An empty result is
 * a legitimate, reportable outcome (`noEvidence: true`) rather than an
 * error — "nothing relevant found" is real information.
 */
export async function searchTripDocuments(
  tripId: string,
  userId: string,
  query: string,
  options: { limit?: number; minSimilarity?: number } = {},
): Promise<SearchTripDocumentsResult> {
  await getTrip(tripId, userId);

  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("A search query is required.");
  }

  const limit = Math.min(Math.max(options.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;

  const provider = getEmbeddingProvider();
  const [queryVector] = await provider.embed([trimmed], "query");

  const rows = await searchChunksByVector(tripId, queryVector, { limit, minSimilarity });

  return {
    query: trimmed,
    chunks: rows.map((row) => ({
      documentId: row.tripDocumentId,
      originalFilename: row.originalFilename,
      chunkIndex: row.chunkIndex,
      content: row.content,
      similarity: row.similarity,
      tokenCount: row.tokenCount,
    })),
    minSimilarity,
    embeddingProvider: provider.providerName,
    semantic: provider.semantic,
    noEvidence: rows.length === 0,
  };
}

/**
 * How much of this trip is actually searchable right now.
 *
 * `indexedDocumentIds` (rather than just a count) exists because the
 * Phase 16 Risk Engine needs to know *which* documents are searchable to
 * judge readiness, and it must ask through this public interface rather
 * than querying `document_chunks` itself — the same module boundary
 * every other cross-module read respects.
 */
export async function getTripIndexStatus(
  tripId: string,
  userId: string,
): Promise<{ indexedChunks: number; indexedDocumentIds: string[] }> {
  await getTrip(tripId, userId);
  const [indexedChunks, indexedDocumentIds] = await Promise.all([
    countChunksForTrip(tripId),
    findIndexedDocumentIdsForTrip(tripId),
  ]);
  return { indexedChunks, indexedDocumentIds };
}
