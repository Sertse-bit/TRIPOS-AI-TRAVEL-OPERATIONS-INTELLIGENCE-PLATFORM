import { pool } from "@/infrastructure/db";

/**
 * Persistence and similarity search for `document_chunks` (Phase 15).
 *
 * Ranking is done by Postgres, using the pgvector `<=>` cosine-distance
 * operator against a real `vector(1024)` column backed by an HNSW index
 * — the queries below are the only place that knows vector syntax
 * exists, so swapping the search strategy can't leak into the domain
 * layer.
 */

export interface DocumentChunkRow {
  id: string;
  tripDocumentId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number | null;
  createdAt: Date;
}

export interface RetrievedChunkRow {
  id: string;
  tripDocumentId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number | null;
  originalFilename: string;
  /** 1 - cosine distance: 1.0 is identical direction, 0 is orthogonal. */
  similarity: number;
}

interface StoredChunk {
  chunkIndex: number;
  content: string;
  tokenCount: number;
  embedding: number[];
}

/**
 * pgvector accepts its own literal syntax, so the array is formatted here
 * rather than relying on a driver's array serializer.
 */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function mapRow(row: {
  id: string;
  trip_document_id: string;
  chunk_index: number;
  content: string;
  token_count: number | null;
  created_at: Date;
}): DocumentChunkRow {
  return {
    id: row.id,
    tripDocumentId: row.trip_document_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    tokenCount: row.token_count,
    createdAt: row.created_at,
  };
}

/**
 * Replaces a document's chunks wholesale, in one transaction.
 *
 * Replace rather than append because re-indexing must be idempotent: the
 * same document re-indexed (new model, new chunking parameters) has to
 * converge on the same rows, not accumulate stale duplicates that would
 * skew every future ranking.
 */
export async function replaceDocumentChunks(
  tripDocumentId: string,
  chunks: StoredChunk[],
): Promise<DocumentChunkRow[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM document_chunks WHERE trip_document_id = $1`, [tripDocumentId]);

    const inserted: DocumentChunkRow[] = [];
    for (const chunk of chunks) {
      const result = await client.query(
        `INSERT INTO document_chunks (trip_document_id, chunk_index, content, token_count, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)
         RETURNING id, trip_document_id, chunk_index, content, token_count, created_at`,
        [
          tripDocumentId,
          chunk.chunkIndex,
          chunk.content,
          chunk.tokenCount,
          toVectorLiteral(chunk.embedding),
        ],
      );
      inserted.push(mapRow(result.rows[0]));
    }

    await client.query("COMMIT");
    return inserted;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function findChunksByDocumentId(tripDocumentId: string): Promise<DocumentChunkRow[]> {
  const result = await pool.query(
    `SELECT id, trip_document_id, chunk_index, content, token_count, created_at
     FROM document_chunks WHERE trip_document_id = $1 ORDER BY chunk_index ASC`,
    [tripDocumentId],
  );
  return result.rows.map(mapRow);
}

export async function countDocumentChunks(tripDocumentId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM document_chunks WHERE trip_document_id = $1`,
    [tripDocumentId],
  );
  return result.rows[0].count;
}

export async function countChunksForTrip(tripId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM document_chunks c
     JOIN trip_documents d ON d.id = c.trip_document_id
     WHERE d.trip_id = $1`,
    [tripId],
  );
  return result.rows[0].count;
}

/**
 * Top-N most similar chunks within one trip.
 *
 * Scoped by `trip_id` rather than by document id list so a query can
 * never reach another trip's documents even if the caller passes a
 * document id it doesn't own — the scope is applied in the same
 * statement as the ranking, not in a prior authorization step that a
 * future refactor could reorder or drop.
 */
export async function searchChunksByVector(
  tripId: string,
  queryEmbedding: number[],
  options: { limit: number; minSimilarity: number },
): Promise<RetrievedChunkRow[]> {
  const result = await pool.query(
    `SELECT c.id,
            c.trip_document_id,
            c.chunk_index,
            c.content,
            c.token_count,
            d.original_filename,
            1 - (c.embedding <=> $1::vector) AS similarity
     FROM document_chunks c
     JOIN trip_documents d ON d.id = c.trip_document_id
     WHERE d.trip_id = $2
       AND c.embedding IS NOT NULL
       AND (1 - (c.embedding <=> $1::vector)) >= $3::float8
     ORDER BY c.embedding <=> $1::vector
     LIMIT $4`,
    [toVectorLiteral(queryEmbedding), tripId, options.minSimilarity, options.limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    tripDocumentId: row.trip_document_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    tokenCount: row.token_count,
    originalFilename: row.original_filename,
    similarity: Number(row.similarity),
  }));
}
