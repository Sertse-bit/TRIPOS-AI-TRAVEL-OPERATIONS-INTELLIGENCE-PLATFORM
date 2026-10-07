import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Failure tests (Phase 28) for the registration deliverability gate.
 *
 * This is the check that most obviously must not become a single point
 * of failure: it calls a third-party API on the signup path, so its
 * policy is that only a real "undeliverable" verdict stops a
 * registration — every other kind of trouble gets out of the way. The
 * provider is stubbed here because that is exactly the variable under
 * test; the real adapters have their own tests in
 * integrations/supporting-providers.test.ts.
 */
const { validateEmail } = vi.hoisted(() => ({ validateEmail: vi.fn() }));

vi.mock("@/integrations/email-validation/provider", () => ({
  getEmailValidationProvider: () => ({ providerName: "test-email-validation", validateEmail }),
}));

import { assertEmailDeliverable } from "@/modules/auth/email-deliverability";
import { ProviderError, ValidationError } from "@/shared/errors";

const EMAIL = "traveler@example.com";

beforeEach(() => {
  validateEmail.mockReset();
});

describe("assertEmailDeliverable", () => {
  it("passes a deliverable address through, asking the provider about that exact address", async () => {
    validateEmail.mockResolvedValue({ valid: true, disposable: false, didYouMean: null });

    await expect(assertEmailDeliverable(EMAIL)).resolves.toBeUndefined();
    expect(validateEmail).toHaveBeenCalledWith(EMAIL);
  });

  it("refuses an address the provider called undeliverable, with a message the user can act on", async () => {
    validateEmail.mockResolvedValue({ valid: false, disposable: false, didYouMean: "gmail.com" });

    await expect(assertEmailDeliverable(EMAIL)).rejects.toBeInstanceOf(ValidationError);
    await expect(assertEmailDeliverable(EMAIL)).rejects.toThrow(
      "This email address doesn't appear to be deliverable.",
    );
  });

  it("fails open when the provider is unreachable, so an outage cannot break signup", async () => {
    validateEmail.mockRejectedValue(new ProviderError("mailboxlayer", "Request timed out."));

    await expect(assertEmailDeliverable(EMAIL)).resolves.toBeUndefined();
  });

  it("fails open on an unexpected error too — not just the errors we predicted", async () => {
    validateEmail.mockRejectedValue(new TypeError("fetch is not a function"));

    await expect(assertEmailDeliverable(EMAIL)).resolves.toBeUndefined();
  });

  it("never swallows an undeliverability verdict, whatever raised it", async () => {
    // The rethrow branch: fail-open is for provider trouble, not for a
    // verdict. If this branch ever inverted, a bad address would sail
    // through exactly when the provider said no.
    validateEmail.mockRejectedValue(
      new ValidationError("This email address doesn't appear to be deliverable."),
    );

    await expect(assertEmailDeliverable(EMAIL)).rejects.toBeInstanceOf(ValidationError);
  });
});
