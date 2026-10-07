import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Failure tests (Phase 28) for the page-level auth gate — the sibling of
 * modules/auth/access-control.test.ts. Both resolve the session through
 * `getSessionUser`, but this one's failure mode is a redirect rather
 * than a thrown AppError, and the redirect has to carry the visitor's
 * intended destination with it or a deep link dies at the login page.
 */
const { getSessionUser, redirect } = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ getSessionUser }));
vi.mock("next/navigation", () => ({ redirect }));

import { requireSession } from "@/app/require-auth";

/**
 * Next's `redirect` signals by throwing a control-flow error. The stub
 * reproduces that contract so the test exercises the real code path (the
 * function must not fall through and return the anonymous user) instead
 * of a stubbed no-op.
 */
class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

const USER = {
  id: "user-1",
  email: "owner@example.com",
  name: "Owner",
  role: "USER" as const,
  passwordHash: "x",
  createdAt: new Date(),
};

beforeEach(() => {
  getSessionUser.mockReset();
  redirect.mockReset();
  redirect.mockImplementation((url: string) => {
    throw new RedirectSignal(url);
  });
});

describe("requireSession", () => {
  it("sends an anonymous visitor to /login with the intended destination preserved", async () => {
    getSessionUser.mockResolvedValue(null);

    await expect(requireSession("/trips/audit")).rejects.toBeInstanceOf(RedirectSignal);
    expect(redirect).toHaveBeenCalledWith("/login?returnTo=%2Ftrips%2Faudit");
  });

  it("defaults the destination to /trips when the caller names none", async () => {
    getSessionUser.mockResolvedValue(null);

    await expect(requireSession()).rejects.toBeInstanceOf(RedirectSignal);
    expect(redirect).toHaveBeenCalledWith("/login?returnTo=%2Ftrips");
  });

  it("encodes the destination rather than concatenating it raw", async () => {
    getSessionUser.mockResolvedValue(null);

    await expect(requireSession("/trips/audit?actor=AI_AGENT")).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    // Unencoded, the `?` and `&` would split the login page's own query
    // string: the guard would silently drop which filter to return to.
    expect(redirect).toHaveBeenCalledWith("/login?returnTo=%2Ftrips%2Faudit%3Factor%3DAI_AGENT");
  });

  it("returns the user and redirects nobody when a session exists", async () => {
    getSessionUser.mockResolvedValue(USER);

    await expect(requireSession("/trips/audit")).resolves.toBe(USER);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("does not invent a user for a session whose account is gone", async () => {
    // getSessionUser collapses "token resolves to a deleted user" to null;
    // the page gate must treat that as anonymous rather than rendering.
    getSessionUser.mockResolvedValue(null);

    await expect(requireSession("/trips")).rejects.toBeInstanceOf(RedirectSignal);
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it("propagates a database failure instead of reading it as signed-out", async () => {
    // Same distinction as the API gate: an outage is not a logout. Here it
    // surfaces as the error page (the route's error boundary), not as a
    // bounce to /login that would look like an expired session.
    getSessionUser.mockRejectedValue(new Error("connection refused"));

    const gate = requireSession("/trips");
    await expect(gate).rejects.toThrow("connection refused");
    expect(redirect).not.toHaveBeenCalled();
  });
});
