import { describe, expect, it, vi } from "vitest";

/**
 * Failure tests (Phase 28) for the auth gate. `requireAuth` is the first
 * line every protected route crosses; the failure modes that matter are
 * that an absent, expired, or corrupt session all produce the same
 * UnauthenticatedError (never a thrown raw error that would surface as a
 * 500), and that a role gate refuses without leaking what would have
 * happened.
 */

const getSessionUser = vi.fn();

vi.mock("@/modules/auth/session", () => ({
  getSessionUser: (...args: unknown[]) => getSessionUser(...args),
}));

import { requireAuth, requireRole } from "@/modules/auth/access-control";
import type { UserRecord } from "@/modules/auth/user-repository";
import { UnauthenticatedError, UnauthorizedError } from "@/shared/errors";

const USER: UserRecord = {
  id: "user-1",
  email: "owner@example.com",
  name: "Owner",
  role: "USER",
  passwordHash: "x",
  emailVerifiedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("requireAuth", () => {
  it("returns the user for a valid session", async () => {
    getSessionUser.mockResolvedValueOnce(USER);
    await expect(requireAuth()).resolves.toBe(USER);
  });

  it("throws UnauthenticatedError — not null, not a 500 — for no session", async () => {
    getSessionUser.mockResolvedValueOnce(null);
    await expect(requireAuth()).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("treats a session whose user vanished (deleted account) as unauthenticated", async () => {
    // getSessionUser already collapses "session row exists but the user is
    // gone" to null; the gate must not distinguish it from anonymous.
    getSessionUser.mockResolvedValueOnce(null);
    await expect(requireAuth()).rejects.toThrow(UnauthenticatedError);
  });

  it("propagates a backend failure as-is so the envelope renders a 500, not a 401", async () => {
    // A database outage must NOT read as "you are not logged in" — that
    // would lock every user out while telling them their session expired.
    getSessionUser.mockRejectedValueOnce(new Error("connection refused"));
    const gate = requireAuth();
    await expect(gate).rejects.toThrow("connection refused");
    await expect(gate).rejects.not.toBeInstanceOf(UnauthenticatedError);
  });
});

describe("requireRole", () => {
  it("lets the matching role through", () => {
    expect(() => requireRole({ ...USER, role: "ADMIN" }, "ADMIN")).not.toThrow();
  });

  it("refuses another role with UnauthorizedError", () => {
    expect(() => requireRole(USER, "ADMIN")).toThrow(UnauthorizedError);
  });

  it("does not echo the user's identity into the error", () => {
    // The refusal is about the role, not the person; the message must not
    // carry the email or id into logs/envelopes needlessly.
    try {
      requireRole(USER, "ADMIN");
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain(USER.email);
      expect(message).not.toContain(USER.id);
    }
  });
});
