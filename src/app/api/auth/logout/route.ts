import { withApiHandler } from "@/shared/api-response";
import { logout, getSessionUser } from "@/modules/auth/session";
import { recordUserAction } from "@/modules/audit/audit-service";

export const POST = withApiHandler(async (requestId, log) => {
  // Resolved before revocation, so the audit row can name who logged out.
  const user = await getSessionUser();

  // Revokes the session row server-side, not just clearing the cookie --
  // the whole point of database-backed sessions (over JWT) is that
  // logout is real, not just "the client stopped sending the token".
  await logout();

  // An anonymous logout (no session at all) is not an action anyone
  // took, so it writes nothing rather than a row with a null actor.
  if (user) {
    recordUserAction({
      requestId,
      userId: user.id,
      action: "auth.logout",
      entityType: "session",
      entityId: requestId,
    });
  }

  log.info("User logged out");
  return { loggedOut: true };
});
