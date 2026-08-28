import { afterEach, describe, expect, it, vi } from "vitest";
import { MockWeatherProvider, WeatherstackProvider } from "@/integrations/weather/provider";
import { ProviderError } from "@/shared/errors";

// Mirrors a real weatherstack /current response — verified against
// marketplace.apilayer.com and davidwalsh.name examples as of 2026-08-27.
const REALISTIC_WEATHERSTACK_RESPONSE = {
  request: { type: "City", query: "Dubai, United Arab Emirates", language: "en", unit: "m" },
  location: {
    name: "Dubai",
    country: "United Arab Emirates",
    region: "Dubai",
    lat: "25.258",
    lon: "55.304",
    timezone_id: "Asia/Dubai",
    localtime: "2026-09-10 14:00",
    localtime_epoch: 1789050000,
    utc_offset: "4.0",
  },
  current: {
    observation_time: "10:00 AM",
    temperature: 41,
    weather_code: 113,
    weather_icons: [
      "https://assets.weatherstack.com/images/wsymbols01_png_64/wsymbol_0001_sunny.png",
    ],
    weather_descriptions: ["Sunny"],
    wind_speed: 12,
    wind_degree: 210,
    wind_dir: "SSW",
    pressure: 1006,
    precip: 0,
    humidity: 35,
    cloudcover: 0,
    feelslike: 44,
    uv_index: 9,
    visibility: 10,
  },
};

describe("WeatherstackProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes a realistic Weatherstack response correctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => REALISTIC_WEATHERSTACK_RESPONSE }),
    );

    const provider = new WeatherstackProvider();
    const result = await provider.getCurrentWeather("Dubai");

    expect(result.locationName).toBe("Dubai");
    expect(result.temperatureCelsius).toBe(41);
    expect(result.windSpeedKph).toBe(12);
    expect(result.condition).toBe("Sunny");
  });

  it("throws ProviderError on Weatherstack's always-200 error shape, not a parse failure", async () => {
    // Weatherstack returns HTTP 200 even for API-level errors (e.g. bad
    // key) -- the error only shows up in the response body. A naive
    // integration checking only response.ok would misparse this as
    // malformed data instead of a clear provider error.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: false,
          error: {
            code: 101,
            type: "invalid_access_key",
            info: "You have not supplied a valid API Access Key.",
          },
        }),
      }),
    );

    const provider = new WeatherstackProvider();
    await expect(provider.getCurrentWeather("Dubai")).rejects.toMatchObject({
      message: "You have not supplied a valid API Access Key.",
    });
  });

  it("throws ProviderError on a genuine non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    const provider = new WeatherstackProvider();
    await expect(provider.getCurrentWeather("Dubai")).rejects.toBeInstanceOf(ProviderError);
  });

  it("throws ProviderError when the response doesn't match the expected shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ nonsense: true }) }),
    );
    const provider = new WeatherstackProvider();
    await expect(provider.getCurrentWeather("Dubai")).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("MockWeatherProvider", () => {
  it("returns clearly-labeled deterministic fixture data", async () => {
    const provider = new MockWeatherProvider();
    const result = await provider.getCurrentWeather("Anywhere");
    expect(result.condition).toContain("dev fixture");
    expect(result.locationName).toContain("mock");
  });
});
