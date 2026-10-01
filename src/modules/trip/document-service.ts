import { getDocumentStorageProvider } from "@/integrations/document-storage/provider";
import { logger } from "@/infrastructure/logger";
import { validateFileUpload } from "@/shared/file-validation";
import type { TripDocumentRecord } from "@/modules/trip/document-repository";
import {
  markDocumentFailed,
  markDocumentProcessing,
  markDocumentReady,
} from "@/modules/trip/document-repository";
import { recordTripEvent } from "@/modules/trip/trip-event-repository";
import {
  extractDocumentContent,
  extractDocumentMetadata,
} from "@/modules/trip/document-extraction";
import { indexTripDocument } from "@/modules/trip/rag-service";
import { attachDocumentToTrip, getTrip } from "@/modules/trip/trip-service";

/**
 * Document Service — the Phase 14 upload + extraction orchestration.
 *
 * Flow (docs/ARCHITECTURE.md Section 13): validate the real bytes →
 * store the original via the DocumentStorageProvider → persist the
 * relationship (status UPLOADED) → extract → status READY or FAILED
 * with a reason. One honest deviation from the architecture diagram:
 * extraction runs inline in the request rather than on a BullMQ worker,
 * because the queue/worker infrastructure is explicitly Phase 18's
 * deliverable. The processing function is isolated so moving it behind
 * a worker later is a wiring change, not a rewrite.
 */

export interface UploadTripDocumentInput {
  buffer: Buffer;
  filename: string;
  declaredMimeType: string;
}

const MAX_FILENAME_LENGTH = 255;

/**
 * Filenames arrive from clients and end up stored and displayed, so they
 * are treated as untrusted: drop any path components (some clients send
 * "C:\fakepath\x.pdf"), strip control characters, cap the length. The
 * original name is kept only as a label — the storage key is what
 * actually identifies the file.
 */
function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.length === 0 ? "untitled" : cleaned.slice(0, MAX_FILENAME_LENGTH);
}

export async function uploadTripDocument(
  tripId: string,
  userId: string,
  input: UploadTripDocumentInput,
): Promise<TripDocumentRecord> {
  // Ownership is checked before any bytes reach the storage provider —
  // an upload to someone else's trip should cost one database read, not
  // a provider call. (attachDocumentToTrip checks again internally; the
  // deliberate double-authorization pattern from the research agent.)
  await getTrip(tripId, userId);

  const { detectedMimeType, sizeBytes } = await validateFileUpload(
    input.buffer,
    input.declaredMimeType,
  );
  const originalFilename = sanitizeFilename(input.filename);

  const stored = await getDocumentStorageProvider().store(
    input.buffer,
    originalFilename,
    detectedMimeType,
  );

  const document = await attachDocumentToTrip(tripId, userId, {
    originalFilename,
    storageKey: stored.storageKey,
    mimeType: detectedMimeType,
    sizeBytes,
  });

  return processTripDocument(document, input.buffer, userId);
}

async function processTripDocument(
  document: TripDocumentRecord,
  buffer: Buffer,
  userId: string,
): Promise<TripDocumentRecord> {
  await markDocumentProcessing(document.id);

  let extraction;
  try {
    extraction = await extractDocumentContent({ buffer, mimeType: document.mimeType });
  } catch (error) {
    // Full parser detail goes to the server log only; the stored reason
    // (which the owner can see) stays a plain description of what failed.
    logger.error({ err: error, documentId: document.id }, "Document text extraction failed");
    return failDocument(document, "Text extraction failed while parsing the document.");
  }

  if (extraction.kind === "unsupported") {
    return failDocument(document, extraction.reason);
  }

  if (extraction.text.trim().length === 0) {
    // Extraction itself succeeded but found nothing. Marking this READY
    // would silently hand Phase 15 an empty document to "retrieve" from.
    return failDocument(
      document,
      "No extractable text found — the document may be a scan without a text layer, and OCR is not implemented in this build.",
    );
  }

  const metadata = extractDocumentMetadata(extraction);
  const ready = await markDocumentReady(document.id, {
    extractedText: extraction.text,
    extractedMetadata: metadata,
  });

  await recordTripEvent({
    tripId: document.tripId,
    eventType: "DOCUMENT_PROCESSED",
    entityType: "trip_document",
    entityId: document.id,
    metadata: {
      pageCount: extraction.pageCount,
      characterCount: metadata.extraction.characterCount,
      truncated: extraction.truncated,
    },
  });

  // Phase 15: index the extracted text for retrieval. Indexing is layered
  // on top of a successful extraction, so a failure here must NOT rewrite
  // an honest READY document as FAILED — the text is already stored and
  // the document can be (re-)indexed on demand via the index endpoint.
  try {
    await indexTripDocument(document.tripId, userId, document.id);
  } catch (error) {
    logger.error(
      { err: error, documentId: document.id },
      "Automatic document indexing failed; document remains READY and can be re-indexed",
    );
  }

  return ready;
}

async function failDocument(
  document: TripDocumentRecord,
  reason: string,
): Promise<TripDocumentRecord> {
  const failed = await markDocumentFailed(document.id, reason);

  await recordTripEvent({
    tripId: document.tripId,
    eventType: "DOCUMENT_PROCESSING_FAILED",
    entityType: "trip_document",
    entityId: document.id,
    metadata: { reason },
  });

  return failed;
}
