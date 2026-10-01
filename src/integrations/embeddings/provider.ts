import { createHash } from "node:crypto";
import { z } from "zod";
import { env } from "@/config/env";
import { ProviderError } from "@/shared/errors";
import { type ExternalProvider, fetchJson } from "@/integrations/types";

/**
 * Text embeddings for the Phase 15 RAG pipeline.
 *
 * Anthropic has no embeddings endpoint, so a separate provider is a hard
 * requirement for vector search, not a nice-to-have. Voyage AI is the
 * embedder: purpose-built for retrieval, and its model dimension is what
 * the `document_chunks.embedding` column is sized to (see
 * `EMBEDDING_DIMENSIONS` below and docs/DATABASE.md).
 *
 * When no key is configured, the factory falls back to a *local
 * deterministic embedder* — not a stubbed response pretending to be a
 * vendor. It computes real vectors by feature hashing, which makes
 * similarity genuinely lexical rather than semantic. That is a real,
 * documented degradation, so every surface that reports retrieval
 * results reports the provider name and whether it is semantic.
 */

/**
 * voyage-3 emits 1024-dimension vectors. Keep this in lockstep with
 * `document_chunks.embedding` in prisma/schema.prisma and with the
 * local embedder below — all three must agree, and the column size is
 * enforced by Postgres, not TypeScript.
 */
export const EMBEDDING_DIMENSIONS = 1024;

export const VOYAGE_EMBEDDING_MODEL = "voyage-3";

/** Voyage accepts batches; 64 is comfortably inside the documented limit. */
const MAX_BATCH_SIZE = 64;

export type EmbeddingInputType = "document" | "query";

export interface EmbeddingProvider extends ExternalProvider {
  readonly dimensions: number;
  /**
   * True only for a real semantic model. The local fallback sets this
   * false so nothing downstream can imply semantic quality it doesn't
   * have.
   */
  readonly semantic: boolean;
  embed(texts: string[], inputType: EmbeddingInputType): Promise<number[][]>;
}

// --- Voyage AI (real adapter) --------------------------------------------

const voyageResponseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()) })),
});

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly providerName = "voyage";
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly semantic = true;

  async embed(texts: string[], inputType: EmbeddingInputType): Promise<number[][]> {
    if (!env.VOYAGE_API_KEY) {
      throw new ProviderError(this.providerName, "Voyage API key is not configured.");
    }
    if (texts.length === 0) return [];

    const vectors: number[][] = [];

    for (let offset = 0; offset < texts.length; offset += MAX_BATCH_SIZE) {
      const batch = texts.slice(offset, offset + MAX_BATCH_SIZE);

      const raw = await fetchJson(this.providerName, "https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.VOYAGE_API_KEY}`,
        },
        body: JSON.stringify({
          input: batch,
          model: VOYAGE_EMBEDDING_MODEL,
          input_type: inputType,
        }),
      });

      const parsed = voyageResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ProviderError(
          this.providerName,
          "Voyage response did not match the expected shape.",
          { issues: parsed.error.issues },
        );
      }

      // A short response would silently misalign every vector with the
      // wrong chunk — the worst possible failure for a retrieval system.
      // Fail loudly instead of indexing shuffled data.
      if (parsed.data.data.length !== batch.length) {
        throw new ProviderError(
          this.providerName,
          `Voyage returned ${parsed.data.data.length} vectors for ${batch.length} inputs.`,
        );
      }

      for (const item of parsed.data.data) {
        if (item.embedding.length !== this.dimensions) {
          throw new ProviderError(
            this.providerName,
            `Voyage returned ${item.embedding.length}-dimension vectors; expected ${this.dimensions}.`,
          );
        }
        vectors.push(item.embedding);
      }
    }

    return vectors;
  }
}

// --- Local deterministic embedder (documented fallback) -------------------

/**
 * Feature hashing ("the hashing trick"): every word hashes to one
 * bucket and a sign, weights accumulate per bucket, and the result is
 * L2-normalized so cosine similarity is meaningful.
 *
 * This is a genuine embedding function over the text — not a mocked
 * vendor response — so retrieval, ranking, and the pgvector path all
 * work end to end without a key. What it is NOT is semantic: it
 * measures shared vocabulary, so paraphrases with no shared words rank
 * poorly. `semantic = false` and the provider name say so out loud, and
 * the app's own rules forbid presenting it as anything better.
 */
export class LocalHashingEmbeddingProvider implements EmbeddingProvider {
  readonly providerName = "local-hashing-embedder";
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly semantic = false;

  // The `inputType` distinction (document vs query) exists because some
  // models embed the two differently. This embedder treats both the same
  // way — it has no notion of either — so the parameter is simply absent
  // here rather than accepted and ignored.
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

    const counts = new Map<string, number>();
    for (const word of words) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }

    for (const [word, count] of counts) {
      const digest = createHash("sha256").update(word).digest();
      const bucket = digest.readUInt32BE(0) % this.dimensions;
      // Second digest byte decides the sign, so unrelated words tend to
      // cancel rather than pile up in the same direction.
      const sign = digest[4] % 2 === 0 ? 1 : -1;
      // Sublinear term weighting: a word repeated 50 times shouldn't
      // dominate the vector 50x.
      vector[bucket] += sign * (1 + Math.log(count));
    }

    return l2Normalize(vector);
  }
}

function l2Normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
}

// --- Factory ------------------------------------------------------------

let cachedProvider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  cachedProvider ??= env.VOYAGE_API_KEY
    ? new VoyageEmbeddingProvider()
    : new LocalHashingEmbeddingProvider();
  return cachedProvider;
}

export function resetEmbeddingProviderCache(): void {
  cachedProvider = null;
}
