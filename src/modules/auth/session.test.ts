import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Session token handling (Phase 27), tested with the repository stubbed —
 * the properties under test are cryptographic, not database ones.
 *
 * The critical property: the raw token exists ONLY in the return value
 * (which becomes the cookie) and never reaches the repository, whose
 * `token_hash` column must only ever see the SHA-256 digest. A leaked
 * `sessions` row must therefore be useless for impersonation.
 */

const createSession = vi.fn();
const findActiveSessionByTokenHash = vi.fn();
const revokeSessionByTokenHash = vi.fn();

vi.mock("@/modules/auth/session-repository", () => ({
  createSession: (...args: unknown[]) => createSession(...args),
  findActiveSessionByTokenHash: (...args: unknown[]) => findActiveSessionByTokenHash(...args),
  revokeSessionByTokenHash: (...args: unknown[]) => revokeSessionByTokenHash(...args),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    set: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  })),
}));

vi.mock("@/config/env", () => ({
  env: { NODE_ENV: "test" },
}));

import { createUserSession } from "@/modules/auth/session";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

beforeEach(() => {
  createSession.mockReset();
  findActiveSessionByTokenHash.mockReset();
  revokeSessionByTokenHash.mockReset();
  createSession.mockResolvedValue(undefined);
});

describe("createUserSession", () => {
  it("returns a 64-hex-character token (32 random bytes) and stores only its hash", async () => {
    const rawToken = await createUserSession("user-1");

    expect(rawToken).toMatch(/^[0-9a-f]{64}$/);
    expect(createSession).toHaveBeenCalledTimes(1);

    const stored = createSession.mock.calls[0][0] as {
      userId: string;
      tokenHash: string;
      expiresAt: Date;
    };
    expect(stored.userId).toBe("user-1");
    expect(stored.tokenHash).toBe(sha256(rawToken));
    // The stored value is a digest, not the token and not a truncated one.
    expect(stored.tokenHash).not.toContain(rawToken);
    expect(stored.tokenHash).toHaveLength(64);
  });

  it("sets an expiry about 30 days out", async () => {
    const before = Date.now();
    await createUserSession("user-1");
    const after = Date.now();
    const { expiresAt } = createSession.mock.calls[0][0] as { expiresAt: Date };
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + thirtyDays - 50);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + thirtyDays + 50);
  });

  it("produces a fresh token (and hash) every call", async () => {
    const first = await createUserSession("user-1");
    const second = await createUserSession("user-1");
    expect(first).not.toBe(second);
    const [a, b] = createSession.mock.calls.map(
      (call) => (call[0] as { tokenHash: string }).tokenHash,
    );
    expect(a).not.toBe(b);
  });

  it("stores a hash that cannot be reversed to the token by a leaked row alone", async () => {
    const rawToken = await createUserSession("user-1");
    const { tokenHash } = createSession.mock.calls[0][0] as { tokenHash: string };
    // The token must not be derivable from the hash by any of the lazy
    // routes: no substring, no case flip, no direct encoding.
    expect(tokenHash.includes(rawToken)).toBe(false);
    expect(Buffer.from(tokenHash, "hex").toString("utf8")).not.toContain(rawToken);
    expect(tokenHash).not.toBe(rawToken);
    // And it round-trips: hashing the returned token again reproduces the
    // stored digest, which is exactly what session lookup does.
    expect(sha256(rawToken)).toBe(tokenHash);
  });

  it("propagates a repository failure instead of pretending to log in", async () => {
    createSession.mockRejectedValue(new Error("sessions table unreachable"));
    await expect(createUserSession("user-1")).rejects.toThrow("sessions table unreachable");
  });
});
