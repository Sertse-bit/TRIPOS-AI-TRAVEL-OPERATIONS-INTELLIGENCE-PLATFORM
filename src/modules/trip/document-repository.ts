import { pool } from "@/infrastructure/db";

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
  createdAt: Date;
}

function mapRow(row: {
  id: string;
  trip_id: string;
  uploaded_by: string;
  original_filename: string;
  storage_key: string;
  mime_type: string;
  size_bytes: number;
  status: DocumentStatus;
  created_at: Date;
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
    createdAt: row.created_at,
  };
}

/**
 * Creates the attachment relationship only (trip_documents row, status
 * UPLOADED). The actual file bytes are expected to already be stored
 * (via DocumentStorageProvider, Phase 5) before this is called. Text
 * extraction, chunking, and embedding — the rest of the pipeline that
 * advances status past UPLOADED — is Phase 14's job.
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
     RETURNING id, trip_id, uploaded_by, original_filename, storage_key, mime_type, size_bytes, status, created_at`,
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
    `SELECT id, trip_id, uploaded_by, original_filename, storage_key, mime_type, size_bytes, status, created_at
     FROM trip_documents WHERE trip_id = $1 ORDER BY created_at DESC`,
    [tripId],
  );
  return result.rows.map(mapRow);
}
