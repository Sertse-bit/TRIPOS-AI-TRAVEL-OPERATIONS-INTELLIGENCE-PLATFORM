import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/infrastructure/db";
import { countDocumentChunks } from "@/modules/trip/document-chunk-repository";
import {
  indexTripDocument,
  searchTripDocuments,
  getTripIndexStatus,
} from "@/modules/trip/rag-service";
import { createTrip } from "@/modules/trip/trip-service";
import { getTripEventHistory } from "@/modules/trip/trip-service";
import { NotFoundError, ValidationError } from "@/shared/errors";

/**
 * These run against a real PostgreSQL with a real pgvector column: the
 * ranking behavior under test IS the `<=>` operator, so a mocked
 * database would test nothing that matters.
 */

const OWNER_EMAIL = "rag-owner@example.com";
const OTHER_EMAIL = "rag-other@example.com";
let ownerId: string;
let otherId: string;

async function createTestUser(email: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'Test') RETURNING id`,
    [email],
  );
  return result.rows[0].id;
}

/**
 * Inserts an already-extracted document so these tests exercise indexing
 * and retrieval only, not the Phase 14 extraction pipeline.
 */
async function insertExtractedDocument(
  tripId: string,
  userId: string,
  filename: string,
  extractedText: string | null,
  status = "READY",
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO trip_documents
       (trip_id, uploaded_by, original_filename, storage_key, mime_type, size_bytes, status, extracted_text)
     VALUES ($1, $2, $3, $4, 'application/pdf', $5, $6::"DocumentStatus", $7)
     RETURNING id`,
    [
      tripId,
      userId,
      filename,
      `test-${filename}`,
      extractedText?.length ?? 0,
      status,
      extractedText,
    ],
  );
  return result.rows[0].id;
}

function repeat(sentence: string, times: number): string {
  return Array.from({ length: times }, () => sentence).join(" ");
}

const HOTEL_TEXT = repeat(
  "The hotel booking in Porto confirms breakfast is included for every guest each morning. ",
  20,
);
const FLIGHT_TEXT = repeat(
  "Flight ET602 departs Addis Ababa at 08:00 local time and arrives in Dubai. ",
  20,
);
const POLICY_TEXT = repeat(
  "The travel insurance policy covers medical evacuation and trip cancellation. ",
  20,
);

async function cleanupTestUsers(): Promise<void> {
  await pool.query(
    `DELETE FROM trip_documents WHERE uploaded_by IN (SELECT id FROM users WHERE email IN ($1, $2))`,
    [OWNER_EMAIL, OTHER_EMAIL],
  );
  await pool.query(`DELETE FROM users WHERE email IN ($1, $2)`, [OWNER_EMAIL, OTHER_EMAIL]);
}

beforeEach(async () => {
  await cleanupTestUsers();
  ownerId = await createTestUser(OWNER_EMAIL);
  otherId = await createTestUser(OTHER_EMAIL);
});

afterEach(async () => {
  await cleanupTestUsers();
});

describe("indexTripDocument", () => {
  it("chunks, embeds, and persists a document's extracted text", async () => {
    const trip = await createTrip(ownerId, { title: "RAG trip" });
    const documentId = await insertExtractedDocument(
      trip.id,
      ownerId,
      "itinerary.pdf",
      `${HOTEL_TEXT}\n\n${FLIGHT_TEXT}\n\n${POLICY_TEXT}`,
    );

    const result = await indexTripDocument(trip.id, ownerId, documentId);

    expect(result.documentId).toBe(documentId);
    expect(result.chunks).toBeGreaterThan(1);
    expect(result.charactersIndexed).toBeGreaterThan(0);
    // No VOYAGE_API_KEY in the test env, so the documented local embedder
    // is what runs — and it must not claim to be semantic.
    expect(result.embeddingProvider).toBe("local-hashing-embedder");
    expect(result.semantic).toBe(false);

    const rows = await pool.query<{ content: string; embedding: string; token_count: number }>(
      `SELECT content, embedding::text AS embedding, token_count
       FROM document_chunks WHERE trip_document_id = $1 ORDER BY chunk_index ASC`,
      [documentId],
    );
    expect(rows.rows).toHaveLength(result.chunks);
    expect(rows.rows[0].embedding).not.toBeNull();
    expect(rows.rows[0].token_count).toBeGreaterThan(0);
    expect(await countDocumentChunks(documentId)).toBe(result.chunks);

    const events = await getTripEventHistory(trip.id, ownerId);
    const indexed = events.find((event) => event.eventType === "DOCUMENT_INDEXED");
    expect(indexed?.metadata).toMatchObject({ chunks: result.chunks });
  });

  it("replaces previous chunks on re-index instead of duplicating them", async () => {
    const trip = await createTrip(ownerId, { title: "Reindex trip" });
    const documentId = await insertExtractedDocument(trip.id, ownerId, "hotel.pdf", HOTEL_TEXT);

    const first = await indexTripDocument(trip.id, ownerId, documentId);
    const second = await indexTripDocument(trip.id, ownerId, documentId);

    expect(second.chunks).toBe(first.chunks);
    expect(await countDocumentChunks(documentId)).toBe(first.chunks);
  });

  it("refuses to index a document that never finished extraction", async () => {
    const trip = await createTrip(ownerId, { title: "Unreadable trip" });
    const documentId = await insertExtractedDocument(trip.id, ownerId, "scan.pdf", null, "FAILED");

    await expect(indexTripDocument(trip.id, ownerId, documentId)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await countDocumentChunks(documentId)).toBe(0);
  });

  it("refuses to index a document belonging to another trip", async () => {
    const trip = await createTrip(ownerId, { title: "Scoped trip" });
    const otherTrip = await createTrip(otherId, { title: "Other trip" });
    const documentId = await insertExtractedDocument(
      otherTrip.id,
      otherId,
      "secret.pdf",
      HOTEL_TEXT,
    );

    // Asked for under the wrong trip, it is simply not found.
    await expect(indexTripDocument(trip.id, ownerId, documentId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("rejects indexing into a trip the caller does not own", async () => {
    const trip = await createTrip(ownerId, { title: "Private trip" });
    const documentId = await insertExtractedDocument(trip.id, ownerId, "hotel.pdf", HOTEL_TEXT);

    await expect(indexTripDocument(trip.id, otherId, documentId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await countDocumentChunks(documentId)).toBe(0);
  });
});

describe("searchTripDocuments", () => {
  async function indexedTrip() {
    const trip = await createTrip(ownerId, { title: "Search trip" });
    const documentId = await insertExtractedDocument(
      trip.id,
      ownerId,
      "itinerary.pdf",
      `${HOTEL_TEXT}\n\n${FLIGHT_TEXT}\n\n${POLICY_TEXT}`,
    );
    await indexTripDocument(trip.id, ownerId, documentId);
    return { trip, documentId };
  }

  it("ranks the chunk whose vocabulary matches the query highest", async () => {
    const { trip } = await indexedTrip();

    const flightHits = await searchTripDocuments(trip.id, ownerId, "ET602 departs Addis Ababa");
    expect(flightHits.chunks.length).toBeGreaterThan(0);
    expect(flightHits.noEvidence).toBe(false);
    expect(flightHits.chunks[0].content).toContain("ET602");

    const hotelHits = await searchTripDocuments(trip.id, ownerId, "hotel Porto breakfast");
    expect(hotelHits.chunks[0].content).toContain("breakfast");
    // The two queries must not collapse onto the same chunk.
    expect(hotelHits.chunks[0].chunkIndex).not.toBe(flightHits.chunks[0].chunkIndex);
  });

  it("reports similarities as bounded, descending, real numbers", async () => {
    const { trip, documentId } = await indexedTrip();

    const result = await searchTripDocuments(trip.id, ownerId, "travel insurance policy");

    expect(result.semantic).toBe(false);
    expect(result.minSimilarity).toBeGreaterThan(0);
    for (const chunk of result.chunks) {
      expect(chunk.similarity).toBeGreaterThanOrEqual(-1);
      expect(chunk.similarity).toBeLessThanOrEqual(1);
      expect(chunk.documentId).toBe(documentId);
    }
    const scores = result.chunks.map((chunk) => chunk.similarity);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("reports an honest empty result instead of padding with weak matches", async () => {
    const { trip } = await indexedTrip();

    const result = await searchTripDocuments(trip.id, ownerId, "zzzz qqqq unrelated", {
      minSimilarity: 0.9,
    });

    expect(result.chunks).toEqual([]);
    expect(result.noEvidence).toBe(true);
  });

  it("never returns another trip's chunks, even with identical text", async () => {
    const { trip } = await indexedTrip();
    const otherTrip = await createTrip(otherId, { title: "Other trip" });
    const otherDocument = await insertExtractedDocument(
      otherTrip.id,
      otherId,
      "same.pdf",
      `${HOTEL_TEXT}\n\n${FLIGHT_TEXT}\n\n${POLICY_TEXT}`,
    );
    await indexTripDocument(otherTrip.id, otherId, otherDocument);

    const result = await searchTripDocuments(trip.id, ownerId, "ET602 departs Addis Ababa");

    const uniqueDocuments = new Set(result.chunks.map((chunk) => chunk.documentId));
    expect(uniqueDocuments.size).toBe(1);
    expect([...uniqueDocuments][0]).not.toBe(otherDocument);
  });

  it("rejects a search against a trip the caller does not own", async () => {
    const { trip } = await indexedTrip();

    await expect(searchTripDocuments(trip.id, otherId, "ET602")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("requires a non-empty query", async () => {
    const { trip } = await indexedTrip();

    await expect(searchTripDocuments(trip.id, ownerId, "   ")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("caps the requested result count", async () => {
    const { trip } = await indexedTrip();

    const result = await searchTripDocuments(trip.id, ownerId, "flight hotel policy", {
      limit: 999,
    });

    expect(result.chunks.length).toBeLessThanOrEqual(20);
  });
});

describe("getTripIndexStatus", () => {
  it("counts this trip's indexed chunks only", async () => {
    const { trip, documentId } = await createTrip(ownerId, { title: "Status trip" }).then(
      async (trip) => {
        const documentId = await insertExtractedDocument(trip.id, ownerId, "hotel.pdf", HOTEL_TEXT);
        await indexTripDocument(trip.id, ownerId, documentId);
        return { trip, documentId };
      },
    );

    const status = await getTripIndexStatus(trip.id, ownerId);

    expect(status.indexedChunks).toBe(await countDocumentChunks(documentId));
  });
});
