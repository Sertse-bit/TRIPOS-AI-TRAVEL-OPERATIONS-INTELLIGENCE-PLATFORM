import { pool } from "@/infrastructure/db";
import { NotFoundError } from "@/shared/errors";

export type DocumentStatus = "UPLOADED" | "PROCESSING" | "READY" | "FAILED";

export interface TripDocumentRecord {
  id: string;
  tripId: string;
  uploadedBy: string;
  originalFilename: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  failureReason: string | null;
  extractedMetadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Columns every read returns. `extracted_text` is deliberately NOT part
 * of this list: it can be megabytes per document and nothing on the
 * summary paths (trip digital twin, document list) needs the body text —
 * Phase 15's chunking pipeline will add its own reader for it.
 */
const SUMMARY_COLUMNS = `
  id, trip_id, uploaded_by, original_filename, storage_key, mime_type,
  size_bytes, status, failure_reason, extracted_metadata, created_at, updated_at
`;

function mapRow(row: {
  id: string;
  trip_id: string;
  uploaded_by: string;
  original_filename: string;
  storage_key: string;
  mime_type: string;
  size_bytes: number;
  status: DocumentStatus;
  failure_reason: string | null;
  extracted_metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}): TripDocumentRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    uploadedBy: row.uploaded_by,
    originalFilename: row.original_filename,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    status: row.status,
    failureReason: row.failure_reason,
    extractedMetadata: row.extracted_metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Creates the attachment relationship (trip_documents row, status
 * UPLOADED). The actual file bytes are expected to already be stored
 * (via DocumentStorageProvider, Phase 5) before this is called. The
 * extraction pipeline that advances status past UPLOADED lives in
 * document-service.ts (Phase 14).
 */
export async function attachDocument(input: {
  tripId: string;
  uploadedBy: string;
  originalFilename: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<TripDocumentRecord> {
  const result = await pool.query(
    `INSERT INTO trip_documents (trip_id, uploaded_by, original_filename, storage_key, mime_type, size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${SUMMARY_COLUMNS}`,
    [
      input.tripId,
      input.uploadedBy,
      input.originalFilename,
      input.storageKey,
      input.mimeType,
      input.sizeBytes,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findDocumentsByTripId(tripId: string): Promise<TripDocumentRecord[]> {
  const result = await pool.query(
    `SELECT ${SUMMARY_COLUMNS} FROM trip_documents WHERE trip_id = $1 ORDER BY created_at DESC`,
    [tripId],
  );
  return result.rows.map(mapRow);
}

export interface TripDocumentWithText extends TripDocumentRecord {
  extractedText: string | null;
}

/**
 * Loads one document together with its extracted body — the only read
 * path that pulls `extracted_text` (Phase 15 indexing). Scoped by trip id
 * as well as document id so a document belonging to another trip is
 * simply not found.
 */
export async function findDocumentWithText(
  tripId: string,
  documentId: string,
): Promise<TripDocumentWithText | null> {
  const result = await pool.query(
    `SELECT ${SUMMARY_COLUMNS}, extracted_text
     FROM trip_documents WHERE trip_id = $1 AND id = $2`,
    [tripId, documentId],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return { ...mapRow(row), extractedText: row.extracted_text };
}

/**
 * Status transitions for the extraction pipeline. Each is a single
 * UPDATE ... RETURNING so the caller gets the freshly persisted row
 * instead of re-reading it.
 *
 * `updated_at` is set explicitly: Prisma's `@updatedAt` is a
 * client-side convenience and has no trigger behind it in the database,
 * so raw SQL writes must maintain it themselves.
 */
export async function markDocumentProcessing(documentId: string): Promise<void> {
  await pool.query(
    `UPDATE trip_documents
     SET status = 'PROCESSING'::"DocumentStatus", updated_at = now()
     WHERE id = $1`,
    [documentId],
  );
}

export async function markDocumentReady(
  documentId: string,
  input: { extractedText: string; extractedMetadata: Record<string, unknown> },
): Promise<TripDocumentRecord> {
  const result = await pool.query(
    `UPDATE trip_documents
     SET status = 'READY'::"DocumentStatus",
         failure_reason = NULL,
         extracted_text = $2,
         extracted_metadata = $3::jsonb,
         updated_at = now()
     WHERE id = $1
     RETURNING ${SUMMARY_COLUMNS}`,
    [documentId, input.extractedText, JSON.stringify(input.extractedMetadata)],
  );

  if (result.rowCount === 0) {
    throw new NotFoundError("TripDocument", documentId);
  }
  return mapRow(result.rows[0]);
}

export async function markDocumentFailed(
  documentId: string,
  failureReason: string,
): Promise<TripDocumentRecord> {
  const result = await pool.query(
    `UPDATE trip_documents
     SET status = 'FAILED'::"DocumentStatus",
         failure_reason = $2,
         updated_at = now()
     WHERE id = $1
     RETURNING ${SUMMARY_COLUMNS}`,
    [documentId, failureReason],
  );

  if (result.rowCount === 0) {
    throw new NotFoundError("TripDocument", documentId);
  }
  return mapRow(result.rows[0]);
}
