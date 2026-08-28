import { NextRequest } from "next/server";
import { withApiHandler } from "@/shared/api-response";
import { ConflictError, ValidationError } from "@/shared/errors";
import { registerSchema } from "@/modules/auth/validation";
import { hashPassword } from "@/modules/auth/password";
import { createUser, findUserByEmail } from "@/modules/auth/user-repository";
import { createUserSession, setSessionCookie } from "@/modules/auth/session";
import { enforceRateLimit } from "@/infrastructure/rate-limit";
import { getEmailValidationProvider } from "@/integrations/email-validation/provider";

function getClientIp(request: NextRequest): string {
  // x-forwarded-for may contain a chain; the first entry is the original
  // client when behind a well-behaved proxy. Falls back to a constant so
  // rate limiting still functions (shared bucket, less precise) if the
  // header is absent -- e.g. local dev without a proxy in front.
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() ?? "unknown";
}

/**
 * The Phase 4 SECURITY.md "known gaps" section deferred this exact check
 * to Phase 5, once a provider-abstraction pattern existed to call it
 * through rather than a one-off fetch in the auth module. Deliberately
 * fails open: if Mailboxlayer is unreachable, misconfigured, or simply
 * not configured (mock adapter always returns valid), registration
 * proceeds anyway. A non-critical enrichment check should never be able
 * to take down the entire signup flow -- the same principle already
 * applied to rate-limit.ts's Redis-unreachable case.
 */
async function checkEmailDeliverability(email: string): Promise<void> {
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

export const POST = withApiHandler(async (_requestId, log, request) => {
  await enforceRateLimit({
    action: "register",
    identifier: getClientIp(request),
    limit: 5,
    windowSeconds: 60 * 60,
  });

  const body = await request.json();
  const input = registerSchema.parse(body);

  await checkEmailDeliverability(input.email);

  const existing = await findUserByEmail(input.email);
  if (existing) {
    // Deliberately vague: doesn't confirm which detail matched. An
    // attacker learns an account exists either way from a register
    // endpoint's nature, so this isn't hiding user enumeration entirely
    // -- but it avoids adding any additional detail beyond that.
    throw new ConflictError("An account with this email already exists.");
  }

  const passwordHash = await hashPassword(input.password);
  const user = await createUser({ email: input.email, passwordHash, name: input.name });

  const sessionToken = await createUserSession(user.id);
  await setSessionCookie(sessionToken);

  log.info({ userId: user.id }, "User registered");

  return {
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  };
});
