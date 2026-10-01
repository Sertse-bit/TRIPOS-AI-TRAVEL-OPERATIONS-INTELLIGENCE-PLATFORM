import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/infrastructure/db";
import { uploadTripDocument } from "@/modules/trip/document-service";
import { createTrip, getTripDocuments, getTripEventHistory } from "@/modules/trip/trip-service";
import { buildMinimalPdf, makeMinimalPng } from "@/modules/trip/document-fixtures";
import { NotFoundError, ProviderError, ValidationError } from "@/shared/errors";

/**
 * The storage provider is the one boundary mocked here. It's a network
 * vendor adapter with its own HTTP-level tests (Phase 5); at the service
 * level the interesting behaviour is the orchestration around it, which
 * needs deterministic success/failure rather than a live Filestack call.
 */
const storageMock = vi.hoisted(() => ({
  store: vi.fn(),
  calls: [] as Array<{ filename: string; mimeType: string; sizeBytes: number }>,
}));

vi.mock("@/integrations/document-storage/provider", () => ({
  getDocumentStorageProvider: () => ({
    providerName: "test-storage",
    store: storageMock.store,
  }),
}));

const OWNER_EMAIL = "document-owner@example.com";
const OTHER_EMAIL = "document-other@example.com";
let ownerId: string;
let otherId: string;

async function createTestUser(email: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'Test') RETURNING id`,
    [email],
  );
  return result.rows[0].id;
}

async function countDocuments(tripId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM trip_documents WHERE trip_id = $1`,
    [tripId],
  );
  return result.rows[0].count;
}

/**
 * trip_documents.uploaded_by has no ON DELETE CASCADE (unlike trip_id),
 * so documents must be removed before their uploader row — otherwise
 * cleanup fails and leaks users that break the next run's inserts.
 */
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

  storageMock.calls.length = 0;
  storageMock.store.mockReset();
  storageMock.store.mockImplementation(
    async (buffer: Buffer, filename: string, mimeType: string) => {
      storageMock.calls.push({
        filename,
        mimeType,
        sizeBytes: buffer.byteLength,
      });
      return {
        storageKey: `test-handle-${storageMock.calls.length}`,
        url: `https://storage.test/${encodeURIComponent(filename)}`,
      };
    },
  );
});

afterEach(async () => {
  await cleanupTestUsers();
});

const BOARDING_PASS_TEXT =
  "BOARDING PASS TripOS Air ET602 Addis Ababa to Dubai 2026-09-10 " +
  "Booking reference: ABC123 Passenger ALICE TRAVELER Seat 12A";

describe("uploadTripDocument", () => {
  it("stores, extracts, and marks a valid PDF READY with events and metadata", async () => {
    const trip = await createTrip(ownerId, { title: "Document trip" });
    const buffer = buildMinimalPdf([BOARDING_PASS_TEXT]);

    const document = await uploadTripDocument(trip.id, ownerId, {
      buffer,
      filename: "C:\\fakepath\\boarding pass.pdf",
      declaredMimeType: "application/pdf",
    });

    // Readiness is earned, not assumed.
    expect(document.status).toBe("READY");
    expect(document.failureReason).toBeNull();
    expect(document.mimeType).toBe("application/pdf");
    expect(document.sizeBytes).toBe(buffer.byteLength);
    // Path components from the client are stripped, not stored.
    expect(document.originalFilename).toBe("boarding pass.pdf");
    expect(document.storageKey).toBe("test-handle-1");
    expect(storageMock.calls).toEqual([
      { filename: "boarding pass.pdf", mimeType: "application/pdf", sizeBytes: buffer.byteLength },
    ]);

    const metadata = document.extractedMetadata as {
      extraction: { method: string; pageCount: number; truncated: boolean };
      flightNumbers: Array<{ value: string }>;
    };
    expect(metadata.extraction).toMatchObject({ method: "pdf-text", pageCount: 1 });
    expect(metadata.flightNumbers.map((fact) => fact.value)).toContain("ET602");

    // The extracted body text is persisted for Phase 15's chunking.
    const row = await pool.query<{ extracted_text: string | null }>(
      `SELECT extracted_text FROM trip_documents WHERE id = $1`,
      [document.id],
    );
    expect(row.rows[0].extracted_text).toContain("ABC123");

    // It shows up in the trip's document list.
    const documents = await getTripDocuments(trip.id, ownerId);
    expect(documents.map((d) => d.id)).toContain(document.id);

    const events = await getTripEventHistory(trip.id, ownerId);
    const processed = events.find((event) => event.eventType === "DOCUMENT_PROCESSED");
    expect(processed?.metadata).toMatchObject({ pageCount: 1 });
    expect(events.some((event) => event.eventType === "DOCUMENT_UPLOADED")).toBe(true);
  });

  it("rejects an upload to a trip the user does not own, without storing anything", async () => {
    const trip = await createTrip(ownerId, { title: "Private trip" });

    await expect(
      uploadTripDocument(trip.id, otherId, {
        buffer: buildMinimalPdf([BOARDING_PASS_TEXT]),
        filename: "secret.pdf",
        declaredMimeType: "application/pdf",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(storageMock.store).not.toHaveBeenCalled();
    expect(await countDocuments(trip.id)).toBe(0);
  });

  it("rejects content whose bytes don't match the declared type", async () => {
    const trip = await createTrip(ownerId, { title: "Mismatch trip" });

    await expect(
      uploadTripDocument(trip.id, ownerId, {
        buffer: buildMinimalPdf([BOARDING_PASS_TEXT]),
        filename: "fake-image.png",
        declaredMimeType: "image/png",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(storageMock.store).not.toHaveBeenCalled();
    expect(await countDocuments(trip.id)).toBe(0);
  });

  it("rejects files whose content type cannot be verified at all", async () => {
    const trip = await createTrip(ownerId, { title: "Garbage trip" });

    await expect(
      uploadTripDocument(trip.id, ownerId, {
        buffer: Buffer.from("this is not a document"),
        filename: "notes.pdf",
        declaredMimeType: "application/pdf",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await countDocuments(trip.id)).toBe(0);
  });

  it("rejects an oversized file before touching the storage provider", async () => {
    const trip = await createTrip(ownerId, { title: "Oversized trip" });

    await expect(
      uploadTripDocument(trip.id, ownerId, {
        buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
        filename: "huge.pdf",
        declaredMimeType: "application/pdf",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(storageMock.store).not.toHaveBeenCalled();
    expect(await countDocuments(trip.id)).toBe(0);
  });

  it("stores images but reports extraction honestly as FAILED (no OCR in this build)", async () => {
    const trip = await createTrip(ownerId, { title: "Image trip" });

    const document = await uploadTripDocument(trip.id, ownerId, {
      buffer: makeMinimalPng(),
      filename: "passport-scan.png",
      declaredMimeType: "image/png",
    });

    expect(document.status).toBe("FAILED");
    expect(document.failureReason).toContain("OCR");
    expect(document.extractedMetadata).toBeNull();

    const row = await pool.query<{ extracted_text: string | null }>(
      `SELECT extracted_text FROM trip_documents WHERE id = $1`,
      [document.id],
    );
    expect(row.rows[0].extracted_text).toBeNull();

    const events = await getTripEventHistory(trip.id, ownerId);
    expect(events.some((event) => event.eventType === "DOCUMENT_PROCESSING_FAILED")).toBe(true);
    expect(events.some((event) => event.eventType === "DOCUMENT_PROCESSED")).toBe(false);
  });

  it("marks a PDF with no text layer FAILED instead of claiming an empty success", async () => {
    const trip = await createTrip(ownerId, { title: "Scan trip" });

    const document = await uploadTripDocument(trip.id, ownerId, {
      buffer: buildMinimalPdf([""]),
      filename: "scanned.pdf",
      declaredMimeType: "application/pdf",
    });

    expect(document.status).toBe("FAILED");
    expect(document.failureReason).toContain("No extractable text found");
  });

  it("marks a corrupt PDF FAILED with a generic reason, keeping parser detail server-side", async () => {
    const trip = await createTrip(ownerId, { title: "Corrupt trip" });

    const document = await uploadTripDocument(trip.id, ownerId, {
      buffer: Buffer.from("%PDF-1.4\nthis body is not a valid document at all"),
      filename: "corrupt.pdf",
      declaredMimeType: "application/pdf",
    });

    expect(document.status).toBe("FAILED");
    expect(document.failureReason).toBe("Text extraction failed while parsing the document.");
  });

  it("propagates a storage provider failure and creates no document row", async () => {
    const trip = await createTrip(ownerId, { title: "Storage outage trip" });
    storageMock.store.mockRejectedValueOnce(
      new ProviderError("test-storage", "Storage provider is unavailable."),
    );

    await expect(
      uploadTripDocument(trip.id, ownerId, {
        buffer: buildMinimalPdf([BOARDING_PASS_TEXT]),
        filename: "boarding-pass.pdf",
        declaredMimeType: "application/pdf",
      }),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(await countDocuments(trip.id)).toBe(0);
  });
});
