import { describe, expect, it } from "vitest";
import { validateFileUpload } from "@/shared/file-validation";
import { ValidationError } from "@/shared/errors";

function pdfBuffer(): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(100)]);
}

function pngBuffer(): Buffer {
  // Signature + IHDR chunk marker — file-type needs both to confirm PNG,
  // confirmed empirically (a bare 8-byte signature alone is not enough).
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from("IHDR"),
    Buffer.alloc(100),
  ]);
}

function jpegBuffer(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
}

describe("validateFileUpload", () => {
  it("accepts a real PDF", async () => {
    const result = await validateFileUpload(pdfBuffer(), "application/pdf");
    expect(result.detectedMimeType).toBe("application/pdf");
  });

  it("accepts a real PNG", async () => {
    const result = await validateFileUpload(pngBuffer(), "image/png");
    expect(result.detectedMimeType).toBe("image/png");
  });

  it("accepts a real JPEG", async () => {
    const result = await validateFileUpload(jpegBuffer(), "image/jpeg");
    expect(result.detectedMimeType).toBe("image/jpeg");
  });

  it("rejects a file with no recognizable signature", async () => {
    const plainText = Buffer.from("just plain text, not a real file");
    await expect(validateFileUpload(plainText, "application/pdf")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("rejects a file type outside the allowlist even if genuinely detected", async () => {
    // A real ELF executable header — genuinely detected by file-type,
    // but must still be rejected: this proves the allowlist check runs
    // independently of "was a type detected at all".
    const elfHeader = Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
      Buffer.alloc(100),
    ]);
    await expect(validateFileUpload(elfHeader, "application/pdf")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("rejects when declared MIME type doesn't match actual content — a PDF relabeled as an image", async () => {
    await expect(validateFileUpload(pdfBuffer(), "image/png")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("rejects an empty file", async () => {
    await expect(validateFileUpload(Buffer.alloc(0), "application/pdf")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("rejects a file over the size limit", async () => {
    const oversized = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(11 * 1024 * 1024)]);
    await expect(validateFileUpload(oversized, "application/pdf")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
