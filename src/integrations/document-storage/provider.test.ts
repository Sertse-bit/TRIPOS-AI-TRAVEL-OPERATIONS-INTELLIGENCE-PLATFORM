import { afterEach, describe, expect, it, vi } from "vitest";
import { FilestackProvider, handleFromStorageUrl } from "@/integrations/document-storage/provider";
import { ProviderError } from "@/shared/errors";

/**
 * The fixture is a VERBATIM live response from
 * `POST https://www.filestackapi.com/api/store/S3` captured on
 * 2026-10-02 with this project's real key. It has no `handle` field —
 * which is exactly the assumption the first version of the adapter made
 * and which would have rejected every successful upload. Pinning the
 * real shape here is the point of this file.
 */
const LIVE_FILESTACK_RESPONSE = {
  url: "https://cdn.filestackcontent.com/cUTksfg2SsGZOgLZL5cL",
  size: 8,
  type: "text/plain",
  filename: "tripos-probe.txt",
};

describe("FilestackProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses the provider's real response and stores the handle as the storage key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => LIVE_FILESTACK_RESPONSE }),
    );

    const provider = new FilestackProvider();
    const stored = await provider.store(Buffer.from("probe-ok"), "tripos-probe.txt", "text/plain");

    expect(stored.url).toBe(LIVE_FILESTACK_RESPONSE.url);
    expect(stored.storageKey).toBe("cUTksfg2SsGZOgLZL5cL");
  });

  it("posts the raw bytes with the detected content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => LIVE_FILESTACK_RESPONSE,
    });
    vi.stubGlobal("fetch", fetchMock);

    await new FilestackProvider().store(Buffer.from("probe-ok"), "a.txt", "text/plain");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("filename=a.txt");
    expect(String(url)).toContain("mimetype=text%2Fplain");
    expect(init.headers["Content-Type"]).toBe("text/plain");
  });

  it("throws ProviderError when the response doesn't match the real shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ unexpected: true }) }),
    );

    await expect(
      new FilestackProvider().store(Buffer.from("x"), "a.txt", "text/plain"),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("handleFromStorageUrl", () => {
  it("extracts the handle from a CDN url, ignoring any trailing slash", () => {
    expect(handleFromStorageUrl("https://cdn.filestackcontent.com/cUTksfg2SsGZOgLZL5cL")).toBe(
      "cUTksfg2SsGZOgLZL5cL",
    );
    expect(handleFromStorageUrl("https://cdn.filestackcontent.com/abc123/")).toBe("abc123");
  });
});
