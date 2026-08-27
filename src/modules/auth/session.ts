import { randomBytes, createHash } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "@/config/env";
import {
  createSession,
  findActiveSessionByTokenHash,
  revokeSessionByTokenHash,
} from "@/modules/auth/session-repository";
import { findUserById, type UserRecord } from "@/modules/auth/user-repository";

export const SESSION_COOKIE_NAME = "tripos_session";
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Hashed with plain SHA-256, not scrypt: a session token is already a
 * high-entropy random value (32 bytes from a CSPRNG), not a low-entropy
 * human-chosen secret like a password. Slow password-hashing KDFs exist
 * specifically to resist brute-forcing a small guessable space — there's
 * nothing to brute force here, so a fast cryptographic hash is the
 * correct tool, and using scrypt here would just add needless latency to
 * every authenticated request.
 */
function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export async function createUserSession(userId: string): Promise<string> {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  await createSession({ userId, tokenHash, expiresAt });

  return rawToken;
}

export async function setSessionCookie(rawToken: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DURATION_MS / 1000,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}

/**
 * Resolves the current request's session cookie to a user, or null if
 * there isn't a valid one. Does not throw — callers decide whether the
 * absence of a session is an error (see requireAuth in access-control.ts).
 */
export async function getSessionUser(): Promise<UserRecord | null> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);
  const session = await findActiveSessionByTokenHash(tokenHash);
  if (!session) return null;

  return findUserById(session.userId);
}

export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (rawToken) {
    await revokeSessionByTokenHash(hashToken(rawToken));
  }
  await clearSessionCookie();
}
