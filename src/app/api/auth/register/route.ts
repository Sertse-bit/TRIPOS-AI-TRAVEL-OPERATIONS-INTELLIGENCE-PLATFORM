import { NextRequest } from "next/server";
import { withApiHandler } from "@/shared/api-response";
import { ConflictError } from "@/shared/errors";
import { registerSchema } from "@/modules/auth/validation";
import { hashPassword } from "@/modules/auth/password";
import { createUser, findUserByEmail } from "@/modules/auth/user-repository";
import { createUserSession, setSessionCookie } from "@/modules/auth/session";
import { enforceRateLimit } from "@/infrastructure/rate-limit";
import { assertEmailDeliverable } from "@/modules/auth/email-deliverability";
import { recordUserAction } from "@/modules/audit/audit-service";

function getClientIp(request: NextRequest): string {
  // x-forwarded-for may contain a chain; the first entry is the original
  // client when behind a well-behaved proxy. Falls back to a constant so
  // rate limiting still functions (shared bucket, less precise) if the
  // header is absent -- e.g. local dev without a proxy in front.
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() ?? "unknown";
}

export const POST = withApiHandler(async (requestId, log, request) => {
  await enforceRateLimit({
    action: "register",
    identifier: getClientIp(request),
    limit: 5,
    windowSeconds: 60 * 60,
  });

  const body = await request.json();
  const input = registerSchema.parse(body);

  // Deliberately fails open on provider trouble and only refuses an
  // address the provider actually called undeliverable — see
  // modules/auth/email-deliverability.ts for the policy.
  await assertEmailDeliverable(input.email);

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
  recordUserAction({
    requestId,
    userId: user.id,
    action: "auth.register",
    entityType: "user",
    entityId: user.id,
  });

  return {
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  };
});
