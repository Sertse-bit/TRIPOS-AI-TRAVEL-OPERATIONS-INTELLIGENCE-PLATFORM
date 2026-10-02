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
// Written from training knowledge of Filestack's REST upload API, then
// VERIFIED LIVE on 2026-10-02 against `POST /api/store/S3` with this
// project's real key — which is what caught a shape assumption the doc
// review could not: the response is `{ url, size, type, filename }` and
// contains no `handle` field. The first version of this adapter required
// one, so every live upload would have been rejected as "did not match
// the expected shape" even though the bytes were stored successfully.
//
// `storageKey` is therefore derived as the last path segment of the
// returned URL (the file's handle, which is also what Filestack's delete
// endpoint takes), rather than read from a field that isn't there.

const filestackResponseSchema = z.object({
  url: z.string().min(1),
  size: z.number().optional(),
  filename: z.string().optional(),
});

/** Last path segment of the returned CDN URL — Filestack's handle for this object. */
export function handleFromStorageUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

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

    return { storageKey: handleFromStorageUrl(parsed.data.url), url: parsed.data.url };
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
