import { afterEach, describe, expect, it, vi } from "vitest";
import { IpstackProvider, MockGeolocationProvider } from "@/integrations/geolocation/provider";
import {
  NumverifyProvider,
  MockPhoneValidationProvider,
} from "@/integrations/phone-validation/provider";
import {
  MailboxlayerProvider,
  MockEmailValidationProvider,
} from "@/integrations/email-validation/provider";
import { ProviderError } from "@/shared/errors";

describe("IpstackProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("normalizes a realistic response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ip: "1.2.3.4",
          city: "Dubai",
          country_name: "United Arab Emirates",
          latitude: 25.2,
          longitude: 55.27,
        }),
      }),
    );
    const result = await new IpstackProvider().lookupIp("1.2.3.4");
    expect(result.city).toBe("Dubai");
    expect(result.country).toBe("United Arab Emirates");
  });

  it("throws ProviderError on a malformed response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ nonsense: true }) }),
    );
    await expect(new IpstackProvider().lookupIp("1.2.3.4")).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("NumverifyProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("normalizes a realistic response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          valid: true,
          international_format: "+971501234567",
          country_name: "United Arab Emirates",
          carrier: "Etisalat",
        }),
      }),
    );
    const result = await new NumverifyProvider().validatePhone("0501234567");
    expect(result.valid).toBe(true);
    expect(result.carrier).toBe("Etisalat");
  });
});

describe("MailboxlayerProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("treats format_valid, not smtp_check, as the deciding factor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        // smtp_check false/null (common — many mail servers block SMTP
        // probing) should NOT make a well-formed address invalid.
        json: async () => ({
          format_valid: true,
          smtp_check: null,
          disposable: false,
          did_you_mean: null,
        }),
      }),
    );
    const result = await new MailboxlayerProvider().validateEmail("alice@example.com");
    expect(result.valid).toBe(true);
  });

  it("flags disposable addresses without necessarily marking them invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          format_valid: true,
          smtp_check: true,
          disposable: true,
          did_you_mean: null,
        }),
      }),
    );
    const result = await new MailboxlayerProvider().validateEmail("test@mailinator.com");
    expect(result.disposable).toBe(true);
  });
});

describe("Mock providers return clearly-labeled fixture data", () => {
  it("MockGeolocationProvider", async () => {
    const result = await new MockGeolocationProvider().lookupIp("1.2.3.4");
    expect(result.city).toContain("Mock");
  });

  it("MockPhoneValidationProvider", async () => {
    const result = await new MockPhoneValidationProvider().validatePhone("123");
    expect(result.countryName).toContain("Mock");
  });

  it("MockEmailValidationProvider", async () => {
    const result = await new MockEmailValidationProvider().validateEmail();
    expect(result.valid).toBe(true);
  });
});
