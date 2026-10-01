import { redirect } from "next/navigation";
import { getSessionUser } from "@/modules/auth/session";
import type { UserRecord } from "@/modules/auth/user-repository";

/**
 * Server-side protected-route wrapper. Every authenticated page renders
 * inside this: it resolves the session from the request's cookies via the
 * same `getSessionUser` used by the API's `requireAuth`, and redirects
 * anonymous visitors to /login while preserving the intended destination
 * as a `returnTo` query parameter the login page forwards after sign-in.
 */
export async function requireSession(returnTo = "/trips"): Promise<UserRecord> {
  const user = await getSessionUser();
  if (!user) {
    redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }
  return user;
}
