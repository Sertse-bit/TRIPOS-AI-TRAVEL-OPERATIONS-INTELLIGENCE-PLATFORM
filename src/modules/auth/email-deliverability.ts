import { getEmailValidationProvider } from "@/integrations/email-validation/provider";
import { ValidationError } from "@/shared/errors";

/**
 * The email-deliverability gate on registration, extracted from the
 * route in Phase 28 so the policy it encodes can be tested directly
 * instead of only through a full signup.
 *
 * The Phase 4 SECURITY.md "known gaps" section deferred this check to
 * Phase 5, once a provider-abstraction pattern existed to call it
 * through rather than a one-off fetch in the auth module.
 *
 * **It deliberately fails open.** A verdict of "undeliverable" is a
 * ValidationError the user needs to see; everything else — the provider
 * being unreachable, misconfigured, or returning a shape we can't read —
 * lets registration proceed. A non-critical enrichment check must never
 * be able to take down the entire signup flow, the same principle
 * already applied to rate-limit.ts's Redis-unreachable case.
 */
export async function assertEmailDeliverable(email: string): Promise<void> {
  try {
    const result = await getEmailValidationProvider().validateEmail(email);
    if (!result.valid) {
      throw new ValidationError("This email address doesn't appear to be deliverable.");
    }
    // Disposable addresses are logged, not rejected -- blocking them
    // outright is a product decision, not a security one, and belongs
    // to a real product requirement if it ever comes up, not a default.
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    // Provider-level failure (network, bad response shape, etc.) --
    // swallow and proceed. Never let this specific check be the reason
    // signup breaks.
  }
}
