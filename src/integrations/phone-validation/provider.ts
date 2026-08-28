import { z } from "zod";
import { env } from "@/config/env";
import { ProviderError } from "@/shared/errors";
import { type ExternalProvider, fetchJson } from "@/integrations/types";

export interface NormalizedPhoneValidation {
  valid: boolean;
  internationalFormat: string | null;
  countryName: string | null;
  carrier: string | null;
}

export interface PhoneValidationProvider extends ExternalProvider {
  validatePhone(number: string): Promise<NormalizedPhoneValidation>;
}

const numverifyResponseSchema = z.object({
  valid: z.boolean(),
  international_format: z.string().nullable().optional(),
  country_name: z.string().nullable().optional(),
  carrier: z.string().nullable().optional(),
});

export class NumverifyProvider implements PhoneValidationProvider {
  readonly providerName = "numverify";

  async validatePhone(number: string): Promise<NormalizedPhoneValidation> {
    if (!env.NUMVERIFY_API_KEY) {
      throw new ProviderError(this.providerName, "Numverify API key is not configured.");
    }
    const url = new URL("https://apilayer.net/api/validate");
    url.searchParams.set("access_key", env.NUMVERIFY_API_KEY);
    url.searchParams.set("number", number);

    const raw = await fetchJson(this.providerName, url.toString());
    const parsed = numverifyResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError(
        this.providerName,
        "Numverify response did not match the expected shape.",
        {
          issues: parsed.error.issues,
        },
      );
    }

    return {
      valid: parsed.data.valid,
      internationalFormat: parsed.data.international_format ?? null,
      countryName: parsed.data.country_name ?? null,
      carrier: parsed.data.carrier ?? null,
    };
  }
}

export class MockPhoneValidationProvider implements PhoneValidationProvider {
  readonly providerName = "mock-phone-validation";

  async validatePhone(number: string): Promise<NormalizedPhoneValidation> {
    return {
      valid: true,
      internationalFormat: number,
      countryName: "Mock Country",
      carrier: "Mock Carrier",
    };
  }
}

let cachedPhoneProvider: PhoneValidationProvider | null = null;
export function getPhoneValidationProvider(): PhoneValidationProvider {
  cachedPhoneProvider ??= env.NUMVERIFY_API_KEY
    ? new NumverifyProvider()
    : new MockPhoneValidationProvider();
  return cachedPhoneProvider;
}
export function resetPhoneValidationProviderCache(): void {
  cachedPhoneProvider = null;
}
