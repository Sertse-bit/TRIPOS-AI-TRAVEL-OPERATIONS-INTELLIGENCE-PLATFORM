import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { withApiHandler } from "@/shared/api-response";
import { UnauthenticatedError } from "@/shared/errors";
import { loginSchema } from "@/modules/auth/validation";
import { hashPassword, verifyPassword } from "@/modules/auth/password";
import { findUserByEmail } from "@/modules/auth/user-repository";
import { createUserSession, setSessionCookie } from "@/modules/auth/session";
import { enforceRateLimit } from "@/infrastructure/rate-limit";

function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() ?? "unknown";
}

export const POST = withApiHandler(async (_requestId, log, request) => {
  const body = await request.json();
  const input = loginSchema.parse(body);

  // Rate limit by BOTH IP and email: IP-based alone lets an attacker
  // spread guesses across many target accounts from one IP without
  // tripping per-account limits; email-based alone lets a botnet
  // distribute guesses against one account across many IPs. Together
  // they close both gaps against a single-endpoint brute force.
  await enforceRateLimit({
    action: "login-ip",
    identifier: getClientIp(request),
    limit: 20,
    windowSeconds: 60 * 60,
  });
  await enforceRateLimit({
    action: "login-email",
    identifier: input.email,
    limit: 8,
    windowSeconds: 60 * 60,
  });

  const user = await findUserByEmail(input.email);

  // Same error, same shape, whether the email doesn't exist or the
  // password is wrong -- a login endpoint that distinguishes the two
  // hands an attacker a free account-enumeration oracle. Also run
  // verifyPassword against a fixed dummy hash in the not-found case so
  // the response time doesn't itself leak which branch was taken.
  const passwordHash = user?.passwordHash ?? (await getDummyHash());
  const passwordValid = await verifyPassword(input.password, passwordHash);

  if (!user || !passwordValid) {
    throw new UnauthenticatedError("Invalid email or password.");
  }

  const sessionToken = await createUserSession(user.id);
  await setSessionCookie(sessionToken);

  log.info({ userId: user.id }, "User logged in");

  return {
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  };
});

// A real scrypt hash of an unguessable placeholder, computed once and
// cached, so the "user not found" path spends roughly the same time as
// the "wrong password" path instead of returning early and revealing the
// account doesn't exist via a timing difference. Generated dynamically
// (not hand-typed hex) so its structure is always guaranteed valid --
// a hand-typed salt/hash of the wrong length would make verifyPassword's
// timingSafeEqual throw instead of safely returning false.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString("hex"));
  return dummyHashPromise;
}
