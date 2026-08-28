import { z } from "zod";
import { env } from "@/config/env";
import { ProviderError } from "@/shared/errors";
import { type ExternalProvider, fetchJson } from "@/integrations/types";

/**
 * This is the integration Phase 4's SECURITY.md explicitly deferred:
 * "calling an external provider directly from the auth module before
 * Phase 5 establishes the general provider-abstraction pattern." That
 * pattern now exists — see registerSchema's usage note in
 * modules/auth/validation.ts for how this plugs back into registration.
 */
export interface NormalizedEmailValidation {
  valid: boolean;
  disposable: boolean;
  didYouMean: string | null;
}

export interface EmailValidationProvider extends ExternalProvider {
  validateEmail(email: string): Promise<NormalizedEmailValidation>;
}

const mailboxlayerResponseSchema = z.object({
  format_valid: z.boolean(),
  smtp_check: z.boolean().nullable().optional(),
  disposable: z.boolean().nullable().optional(),
  did_you_mean: z.string().nullable().optional(),
});

export class MailboxlayerProvider implements EmailValidationProvider {
  readonly providerName = "mailboxlayer";

  async validateEmail(email: string): Promise<NormalizedEmailValidation> {
    if (!env.MAILBOXLAYER_API_KEY) {
      throw new ProviderError(this.providerName, "Mailboxlayer API key is not configured.");
    }
    const url = new URL("https://apilayer.net/api/check");
    url.searchParams.set("access_key", env.MAILBOXLAYER_API_KEY);
    url.searchParams.set("email", email);

    const raw = await fetchJson(this.providerName, url.toString());
    const parsed = mailboxlayerResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError(
        this.providerName,
        "Mailboxlayer response did not match the expected shape.",
        {
          issues: parsed.error.issues,
        },
      );
    }

    return {
      // format_valid, not smtp_check, is the deciding factor: SMTP
      // deliverability checks are frequently blocked or unreliable across
      // mail providers and would reject plenty of genuinely valid
      // addresses if treated as authoritative.
      valid: parsed.data.format_valid,
      disposable: parsed.data.disposable ?? false,
      didYouMean: parsed.data.did_you_mean || null,
    };
  }
}

export class MockEmailValidationProvider implements EmailValidationProvider {
  readonly providerName = "mock-email-validation";

  async validateEmail(): Promise<NormalizedEmailValidation> {
    return { valid: true, disposable: false, didYouMean: null };
  }
}

let cachedEmailProvider: EmailValidationProvider | null = null;
export function getEmailValidationProvider(): EmailValidationProvider {
  cachedEmailProvider ??= env.MAILBOXLAYER_API_KEY
    ? new MailboxlayerProvider()
    : new MockEmailValidationProvider();
  return cachedEmailProvider;
}
export function resetEmailValidationProviderCache(): void {
  cachedEmailProvider = null;
}
