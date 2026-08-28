import { z } from "zod";
import { env } from "@/config/env";
import { ProviderError } from "@/shared/errors";
import { type ExternalProvider, fetchJson } from "@/integrations/types";

export interface NormalizedLocation {
  ip: string;
  city: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface GeolocationProvider extends ExternalProvider {
  lookupIp(ip: string): Promise<NormalizedLocation>;
}

const ipstackResponseSchema = z.object({
  ip: z.string(),
  city: z.string().nullable().optional(),
  country_name: z.string().nullable().optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
});

export class IpstackProvider implements GeolocationProvider {
  readonly providerName = "ipstack";

  async lookupIp(ip: string): Promise<NormalizedLocation> {
    if (!env.IPSTACK_API_KEY) {
      throw new ProviderError(this.providerName, "IPstack API key is not configured.");
    }
    const url = new URL(`https://api.ipstack.com/${ip}`);
    url.searchParams.set("access_key", env.IPSTACK_API_KEY);

    const raw = await fetchJson(this.providerName, url.toString());
    const parsed = ipstackResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError(
        this.providerName,
        "IPstack response did not match the expected shape.",
        {
          issues: parsed.error.issues,
        },
      );
    }

    return {
      ip: parsed.data.ip,
      city: parsed.data.city ?? null,
      country: parsed.data.country_name ?? null,
      latitude: parsed.data.latitude ?? null,
      longitude: parsed.data.longitude ?? null,
    };
  }
}

export class MockGeolocationProvider implements GeolocationProvider {
  readonly providerName = "mock-geolocation";

  async lookupIp(ip: string): Promise<NormalizedLocation> {
    return { ip, city: "Mock City", country: "Mock Country", latitude: 0, longitude: 0 };
  }
}

let cachedGeoProvider: GeolocationProvider | null = null;
export function getGeolocationProvider(): GeolocationProvider {
  cachedGeoProvider ??= env.IPSTACK_API_KEY ? new IpstackProvider() : new MockGeolocationProvider();
  return cachedGeoProvider;
}
export function resetGeolocationProviderCache(): void {
  cachedGeoProvider = null;
}
