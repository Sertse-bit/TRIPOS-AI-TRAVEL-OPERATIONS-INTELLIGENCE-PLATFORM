import { z } from "zod";
import { env } from "@/config/env";
import { ProviderError } from "@/shared/errors";
import { type ExternalProvider, fetchJson } from "@/integrations/types";

/**
 * Normalized search result. Zenserp's response format (organic results
 * with position/title/url/description fields) was originally written
 * from training knowledge, explicitly flagged as unverified — then
 * verified live on 2026-10-02 with this project's real key: a real
 * `GET /api/v2/search` returned `organic[]` with exactly
 * `{position, title, url, description}` (plus `destination`, `isAmp`),
 * which is what this schema already parsed. The flag is cleared because
 * the shape was observed, not because time passed.
 */
export interface NormalizedSearchResult {
  title: string;
  url: string;
  snippet: string;
  position: number;
}

export interface SearchProvider extends ExternalProvider {
  search(query: string): Promise<NormalizedSearchResult[]>;
}

// --- Real adapter --------------------------------------------------------

const zenserpResponseSchema = z.object({
  organic: z
    .array(
      z.object({
        position: z.number(),
        title: z.string(),
        url: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional(),
});

export class ZenserpProvider implements SearchProvider {
  readonly providerName = "zenserp";

  async search(query: string): Promise<NormalizedSearchResult[]> {
    if (!env.ZENSERP_API_KEY) {
      throw new ProviderError(this.providerName, "Zenserp API key is not configured.");
    }

    const url = new URL("https://app.zenserp.com/api/v2/search");
    url.searchParams.set("q", query);

    const raw = await fetchJson(this.providerName, url.toString(), {
      headers: { apikey: env.ZENSERP_API_KEY },
    });

    const parsed = zenserpResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError(
        this.providerName,
        "Zenserp response did not match the expected shape.",
        {
          issues: parsed.error.issues,
        },
      );
    }

    // The Research Agent (Phase 13) must "preserve source references" and
    // never present search-generated information as verified fact
    // without evidence — returning url + snippet alongside every result
    // is what makes that possible downstream.
    return (parsed.data.organic ?? []).map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.description ?? "",
      position: result.position,
    }));
  }
}

// --- Mock adapter ------------------------------------------------------

export class MockSearchProvider implements SearchProvider {
  readonly providerName = "mock-search";

  async search(query: string): Promise<NormalizedSearchResult[]> {
    return [
      {
        title: `Mock result for "${query}" (dev fixture)`,
        url: "https://example.com/mock-result",
        snippet: "This is placeholder search content for development and testing only.",
        position: 1,
      },
    ];
  }
}

// --- Factory -----------------------------------------------------------

let cachedProvider: SearchProvider | null = null;

export function getSearchProvider(): SearchProvider {
  cachedProvider ??= env.ZENSERP_API_KEY ? new ZenserpProvider() : new MockSearchProvider();
  return cachedProvider;
}

export function resetSearchProviderCache(): void {
  cachedProvider = null;
}
