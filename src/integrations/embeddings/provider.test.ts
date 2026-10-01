// Set before any import is evaluated, so `@/config/env` sees the key and
// the factory resolves to the real adapter for these tests. Deliberately
// NOT added to vitest.setup.ts: every other suite must keep using the
// local embedder rather than making real network calls.
vi.hoisted(() => {
  process.env.VOYAGE_API_KEY = "test-key-voyage";
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
  LocalHashingEmbeddingProvider,
  VoyageEmbeddingProvider,
  getEmbeddingProvider,
} from "@/integrations/embeddings/provider";
import { ProviderError } from "@/shared/errors";

function makeVector(dimensions: number, fill: number): number[] {
  return new Array(dimensions).fill(fill);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, value, index) => sum + value * b[index], 0);
  const magnitudeA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
  const magnitudeB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0));
  return dot / (magnitudeA * magnitudeB);
}

describe("LocalHashingEmbeddingProvider", () => {
  // Typed as the interface so the calls below exercise the same contract
  // callers use, including the inputType argument.
  const provider: EmbeddingProvider = new LocalHashingEmbeddingProvider();

  it("produces a vector of the configured dimension", async () => {
    const [vector] = await provider.embed(["boarding pass"], "document");

    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("is deterministic — the same text always yields the same vector", async () => {
    const [first] = await provider.embed(["flight ET602 to Dubai"], "query");
    const [second] = await provider.embed(["flight ET602 to Dubai"], "query");

    expect(first).toEqual(second);
  });

  it("L2-normalizes, so cosine similarity is meaningful", async () => {
    const [vector] = await provider.embed(["a boarding pass for flight ET602"], "document");
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

    expect(magnitude).toBeCloseTo(1, 6);
  });

  it("ranks text sharing vocabulary as more similar than unrelated text", async () => {
    const [query] = await provider.embed(["hotel booking in Porto with breakfast"], "query");
    const [related] = await provider.embed(
      ["The hotel booking in Porto includes breakfast each morning."],
      "document",
    );
    const [unrelated] = await provider.embed(
      ["Rotate the tyre every 5000 kilometres and check the torque."],
      "document",
    );

    expect(cosineSimilarity(query, related)).toBeGreaterThan(cosineSimilarity(query, unrelated));
  });

  it("declares itself non-semantic and says so in its provider name", () => {
    // The project's rules forbid presenting a weaker mechanism as a
    // vendor model's understanding, so this must never read as one.
    expect(provider.semantic).toBe(false);
    expect(provider.providerName).toBe("local-hashing-embedder");
  });

  it("returns a zero vector for empty text instead of NaNs", async () => {
    const [vector] = await provider.embed([""], "document");

    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(vector.every((value) => value === 0)).toBe(true);
  });
});

describe("VoyageEmbeddingProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the documented request and returns vectors in input order", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { embedding: makeVector(EMBEDDING_DIMENSIONS, 0.1) },
          { embedding: makeVector(EMBEDDING_DIMENSIONS, 0.2) },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const vectors = await new VoyageEmbeddingProvider().embed(
      ["first chunk", "second chunk"],
      "document",
    );

    expect(vectors).toHaveLength(2);
    expect(vectors[0][0]).toBeCloseTo(0.1, 6);
    expect(vectors[1][0]).toBeCloseTo(0.2, 6);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key-voyage");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("voyage-3");
    expect(body.input_type).toBe("document");
    expect(body.input).toEqual(["first chunk", "second chunk"]);
  });

  it("passes the query input type through for search queries", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: makeVector(EMBEDDING_DIMENSIONS, 0.3) }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await new VoyageEmbeddingProvider().embed(["what time is my flight?"], "query");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).input_type).toBe("query");
  });

  it("batches large inputs instead of sending one unbounded request", async () => {
    const texts = Array.from({ length: 130 }, (_, i) => `chunk ${i}`);
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        data: texts.slice(0, 64).map(() => ({ embedding: makeVector(EMBEDDING_DIMENSIONS, 0.1) })),
      }),
    }));
    // Every call answers with 64 vectors; the last batch asks for 2.
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        data: Array.from({ length: 64 }, () => ({
          embedding: makeVector(EMBEDDING_DIMENSIONS, 0.1),
        })),
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    // A stub that always returns 64 for a 2-text final batch must fail
    // loudly rather than misalign chunks to vectors.
    await expect(new VoyageEmbeddingProvider().embed(texts, "document")).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("makes no request at all for an empty input list", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await new VoyageEmbeddingProvider().embed([], "document")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a short response instead of shifting vectors onto wrong chunks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: makeVector(EMBEDDING_DIMENSIONS, 0.1) }] }),
      }),
    );

    await expect(
      new VoyageEmbeddingProvider().embed(["one", "two"], "document"),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("rejects vectors whose dimension does not match the schema column", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: makeVector(512, 0.1) }] }),
      }),
    );

    await expect(new VoyageEmbeddingProvider().embed(["one"], "document")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("rejects a malformed response shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ unexpected: true }) }),
    );

    await expect(new VoyageEmbeddingProvider().embed(["one"], "document")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("surfaces an HTTP failure as a ProviderError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ error: "rate limited" }),
      }),
    );

    await expect(new VoyageEmbeddingProvider().embed(["one"], "document")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

describe("getEmbeddingProvider", () => {
  it("resolves to the real adapter when a key is configured", () => {
    expect(getEmbeddingProvider().providerName).toBe("voyage");
  });
});
