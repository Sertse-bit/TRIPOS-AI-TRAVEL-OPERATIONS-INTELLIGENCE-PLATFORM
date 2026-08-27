import { describe, expect, it } from "vitest";
import { hashPassword, validatePasswordStrength, verifyPassword } from "@/modules/auth/password";

describe("password hashing", () => {
  it("hashes and verifies a correct password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPassword("correct-horse-battery-staple", hash)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPassword("wrong-password-entirely", hash)).toBe(false);
  });

  it("produces a different hash for the same password each time (salted)", async () => {
    const hashA = await hashPassword("same-password-both-times");
    const hashB = await hashPassword("same-password-both-times");
    expect(hashA).not.toBe(hashB);
    // but both still verify correctly against their own hash
    expect(await verifyPassword("same-password-both-times", hashA)).toBe(true);
    expect(await verifyPassword("same-password-both-times", hashB)).toBe(true);
  });

  it("stores cost parameters alongside the hash", async () => {
    const hash = await hashPassword("some-password-value");
    expect(hash.split("$")[0]).toBe("scrypt");
    expect(hash.split("$")).toHaveLength(6);
  });

  it("rejects malformed stored hashes instead of throwing", async () => {
    expect(await verifyPassword("anything", "not-a-real-hash")).toBe(false);
    expect(await verifyPassword("anything", "bcrypt$notscrypt")).toBe(false);
  });
});

describe("password strength validation", () => {
  it("rejects passwords under the minimum length", () => {
    expect(validatePasswordStrength("short").valid).toBe(false);
  });

  it("rejects passwords over the maximum length", () => {
    expect(validatePasswordStrength("a".repeat(200)).valid).toBe(false);
  });

  it("accepts a long passphrase without requiring symbols or digits", () => {
    // Deliberately no uppercase/digit/symbol — NIST 800-63B guidance:
    // length matters more than composition rules.
    expect(validatePasswordStrength("this is a perfectly good long passphrase").valid).toBe(true);
  });

  it("accepts a password exactly at the minimum length", () => {
    expect(validatePasswordStrength("a".repeat(12)).valid).toBe(true);
  });
});
