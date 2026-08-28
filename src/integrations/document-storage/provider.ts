import { z } from "zod";
import { env } from "@/config/env";
import { ProviderError } from "@/shared/errors";
import { type ExternalProvider, fetchJson } from "@/integrations/types";

export interface StoredFile {
  storageKey: string;
  url: string;
}

export interface DocumentStorageProvider extends ExternalProvider {
  store(fileBuffer: Buffer, filename: string, mimeType: string): Promise<StoredFile>;
}

// --- Real adapter --------------------------------------------------------
//
// Based on training knowledge of Filestack's REST upload API (multipart
// upload to a keyed endpoint, returning a handle/URL) rather than a
// source verified during this build session — Filestack's actual upload
// flow has more moving parts (multipart intelligent ingestion, webhooks)
// than this simple version covers. Treat this as a starting point to
// verify and likely expand against https://www.filestack.com/docs/api/
// before Phase 14 builds the real upload pipeline on top of it, not a
// finished integration.

const filestackResponseSchema = z.object({
  handle: z.string(),
  url: z.string(),
});

export class FilestackProvider implements DocumentStorageProvider {
  readonly providerName = "filestack";

  async store(fileBuffer: Buffer, filename: string, mimeType: string): Promise<StoredFile> {
    if (!env.FILESTACK_API_KEY) {
      throw new ProviderError(this.providerName, "Filestack API key is not configured.");
    }

    const url = `https://www.filestackapi.com/api/store/S3?key=${env.FILESTACK_API_KEY}&filename=${encodeURIComponent(filename)}&mimetype=${encodeURIComponent(mimeType)}`;

    const raw = await fetchJson(this.providerName, url, {
      method: "POST",
      body: new Uint8Array(fileBuffer),
      headers: { "Content-Type": mimeType },
    });

    const parsed = filestackResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError(
        this.providerName,
        "Filestack response did not match the expected shape.",
        {
          issues: parsed.error.issues,
        },
      );
    }

    return { storageKey: parsed.data.handle, url: parsed.data.url };
  }
}

// --- Mock adapter ------------------------------------------------------

export class MockDocumentStorageProvider implements DocumentStorageProvider {
  readonly providerName = "mock-document-storage";

  async store(fileBuffer: Buffer, filename: string): Promise<StoredFile> {
    const fakeHandle = `mock-${Date.now()}-${filename}`;
    return { storageKey: fakeHandle, url: `https://example.com/mock-storage/${fakeHandle}` };
  }
}

// --- Factory -----------------------------------------------------------

let cachedProvider: DocumentStorageProvider | null = null;

export function getDocumentStorageProvider(): DocumentStorageProvider {
  cachedProvider ??= env.FILESTACK_API_KEY
    ? new FilestackProvider()
    : new MockDocumentStorageProvider();
  return cachedProvider;
}

export function resetDocumentStorageProviderCache(): void {
  cachedProvider = null;
}
