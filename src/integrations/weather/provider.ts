import { z } from "zod";
import { env } from "@/config/env";
import { ProviderError } from "@/shared/errors";
import { type ExternalProvider, fetchJson } from "@/integrations/types";

/**
 * Normalized shape every caller works with. Field names verified against
 * Weatherstack's actual documented response — cross-checked across
 * multiple independent real API response examples (marketplace.apilayer.com,
 * davidwalsh.name, tutorialsteacher.com) as of 2026-08-27. Re-verify
 * against live docs before this is ever run for real:
 * https://weatherstack.com/documentation
 */
export interface NormalizedWeather {
  locationName: string;
  country: string;
  observationTime: string;
  temperatureCelsius: number;
  windSpeedKph: number;
  precipitationMm: number;
  humidity: number;
  condition: string;
}

export interface WeatherProvider extends ExternalProvider {
  getCurrentWeather(query: string): Promise<NormalizedWeather>;
}

// --- Real adapter --------------------------------------------------------

const weatherstackResponseSchema = z.object({
  location: z.object({ name: z.string(), country: z.string() }),
  current: z.object({
    observation_time: z.string(),
    temperature: z.number(),
    wind_speed: z.number(),
    precip: z.number(),
    humidity: z.number(),
    weather_descriptions: z.array(z.string()),
  }),
});

const weatherstackErrorSchema = z.object({
  success: z.literal(false),
  error: z.object({ code: z.number().optional(), info: z.string().optional() }),
});

export class WeatherstackProvider implements WeatherProvider {
  readonly providerName = "weatherstack";

  async getCurrentWeather(query: string): Promise<NormalizedWeather> {
    if (!env.WEATHERSTACK_API_KEY) {
      throw new ProviderError(this.providerName, "Weatherstack API key is not configured.");
    }

    // Weatherstack's own dedicated domain + access_key query param —
    // consistently documented this way across years of sources, unlike
    // Fixer which has migrated to the unified apilayer.com gateway.
    const url = new URL("https://api.weatherstack.com/current");
    url.searchParams.set("access_key", env.WEATHERSTACK_API_KEY);
    url.searchParams.set("query", query);
    url.searchParams.set("units", "m"); // metric: Celsius, kph, mm

    const raw = await fetchJson(this.providerName, url.toString());

    // Weatherstack returns HTTP 200 even for API-level errors (invalid
    // key, invalid query) — the error is only visible in the body shape,
    // not the status code. Must check for it explicitly before the
    // success schema, or a real error would be misparsed as malformed
    // data instead of reported clearly.
    const errorParsed = weatherstackErrorSchema.safeParse(raw);
    if (errorParsed.success) {
      throw new ProviderError(
        this.providerName,
        errorParsed.data.error.info ?? "Weatherstack returned an error.",
        { code: errorParsed.data.error.code },
      );
    }

    const parsed = weatherstackResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError(
        this.providerName,
        "Weatherstack response did not match the expected shape.",
        { issues: parsed.error.issues },
      );
    }

    return {
      locationName: parsed.data.location.name,
      country: parsed.data.location.country,
      observationTime: parsed.data.current.observation_time,
      temperatureCelsius: parsed.data.current.temperature,
      windSpeedKph: parsed.data.current.wind_speed,
      precipitationMm: parsed.data.current.precip,
      humidity: parsed.data.current.humidity,
      condition: parsed.data.current.weather_descriptions[0] ?? "Unknown",
    };
  }
}

// --- Mock adapter ----------------------------------------------------------

export class MockWeatherProvider implements WeatherProvider {
  readonly providerName = "mock-weather";

  async getCurrentWeather(query: string): Promise<NormalizedWeather> {
    return {
      locationName: `${query} (mock)`,
      country: "Mock Country",
      observationTime: new Date().toISOString(),
      temperatureCelsius: 22,
      windSpeedKph: 10,
      precipitationMm: 0,
      humidity: 50,
      condition: "Clear (dev fixture)",
    };
  }
}

// --- Factory -----------------------------------------------------------

let cachedProvider: WeatherProvider | null = null;

export function getWeatherProvider(): WeatherProvider {
  cachedProvider ??= env.WEATHERSTACK_API_KEY
    ? new WeatherstackProvider()
    : new MockWeatherProvider();
  return cachedProvider;
}

export function resetWeatherProviderCache(): void {
  cachedProvider = null;
}
