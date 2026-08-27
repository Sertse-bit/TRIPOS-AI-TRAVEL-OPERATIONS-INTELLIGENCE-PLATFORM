import { fileTypeFromBuffer } from "file-type";
import { ValidationError } from "@/shared/errors";

/**
 * Built now (Phase 4 explicitly calls for "file upload validation") as a
 * standalone, reusable primitive. The actual upload route/pipeline that
 * calls this belongs to Phase 14 (Document Intelligence) — this is
 * intentionally just the validation logic, not the feature.
 */

const ALLOWED_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export interface FileValidationResult {
  detectedMimeType: string;
  sizeBytes: number;
}

/**
 * Validates a file by its actual content, not its filename or the
 * Content-Type header the client sent — both are trivially spoofable.
 * Sniffs the real magic bytes via `file-type` (checked against the
 * signature table it maintains, not naive hand-rolled byte comparisons)
 * and rejects anything outside the allowlist, oversized, or where the
 * declared type doesn't match what the bytes actually are.
 */
export async function validateFileUpload(
  buffer: Buffer,
  declaredMimeType: string,
): Promise<FileValidationResult> {
  if (buffer.byteLength === 0) {
    throw new ValidationError("Uploaded file is empty.");
  }

  if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
    throw new ValidationError(`File exceeds the ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB limit.`, {
      sizeBytes: buffer.byteLength,
    });
  }

  const detected = await fileTypeFromBuffer(buffer);

  if (!detected) {
    throw new ValidationError(
      "Could not verify file type from its contents. Only PDF, JPEG, and PNG are accepted.",
    );
  }

  if (!ALLOWED_MIME_TYPES.has(detected.mime)) {
    throw new ValidationError(
      `File type "${detected.mime}" is not accepted. Only PDF, JPEG, and PNG are accepted.`,
      { detectedMimeType: detected.mime },
    );
  }

  if (detected.mime !== declaredMimeType) {
    // Not necessarily malicious — browsers get this wrong sometimes too —
    // but worth surfacing rather than silently trusting either value.
    throw new ValidationError(
      `Declared file type "${declaredMimeType}" does not match actual content ("${detected.mime}").`,
      { declaredMimeType, detectedMimeType: detected.mime },
    );
  }

  return { detectedMimeType: detected.mime, sizeBytes: buffer.byteLength };
}
