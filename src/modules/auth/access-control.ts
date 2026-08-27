import { UnauthenticatedError, UnauthorizedError } from "@/shared/errors";
import { getSessionUser } from "@/modules/auth/session";
import type { UserRecord } from "@/modules/auth/user-repository";

/**
 * Throws UnauthenticatedError if there's no valid session. Route handlers
 * call this explicitly at the top rather than relying on Next.js
 * middleware — Prisma-generated-client-adjacent DB access (see
 * infrastructure/db.ts) needs the Node runtime, and an explicit call in
 * each handler is more legible than an implicit global gate anyway (the
 * brief's own "explicit contracts" preference, Section 37).
 */
export async function requireAuth(): Promise<UserRecord> {
  const user = await getSessionUser();
  if (!user) {
    throw new UnauthenticatedError();
  }
  return user;
}

/**
 * Resource-level (row) authorization — e.g. "does this user own this
 * trip" — belongs to each domain module as it's built (Trip Service in
 * Phase 7 onward), using this same AppError pattern. This module only
 * covers what's universal: authentication, and role-based checks for
 * routes that don't hang off a specific owned resource (e.g. an eventual
 * admin-only observability endpoint in Phase 23).
 */
export function requireRole(user: UserRecord, role: "ADMIN"): void {
  if (user.role !== role) {
    throw new UnauthorizedError(`This action requires the ${role} role.`);
  }
}
