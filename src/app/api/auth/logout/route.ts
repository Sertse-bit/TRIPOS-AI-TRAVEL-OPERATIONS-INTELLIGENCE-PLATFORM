import { withApiHandler } from "@/shared/api-response";
import { logout } from "@/modules/auth/session";

export const POST = withApiHandler(async (_requestId, log) => {
  // Revokes the session row server-side, not just clearing the cookie --
  // the whole point of database-backed sessions (over JWT) is that
  // logout is real, not just "the client stopped sending the token".
  await logout();
  log.info("User logged out");
  return { loggedOut: true };
});
