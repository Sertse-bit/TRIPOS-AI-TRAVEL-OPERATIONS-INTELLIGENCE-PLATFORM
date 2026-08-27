import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// Node's crypto.scrypt has multiple overloaded signatures (with and
// without an options argument). util.promisify()'s type inference picks
// the simplest one (3 args, no options), which rejects the options
// argument at compile time even though the underlying function accepts
// it fine at runtime -- promisify only wraps the callback removal, it
// doesn't change what arguments the real function accepts. This explicit
// type annotation selects the correct overload rather than losing type
// safety with an `any` cast at every call site.
const scrypt: (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer> = promisify(scryptCallback);

/**
 * scrypt, not bcrypt/argon2: OWASP lists scrypt as an acceptable KDF when
 * Argon2id isn't available, and Node's implementation is built in — no
 * native addon to compile, which matters for portability across dev
 * machines, CI runners, and this sandbox alike (bcrypt/argon2 packages
 * need node-gyp and can fail to build in constrained environments).
 *
 * Parameters (N=16384, r=8, p=1) are the well-established "interactive"
 * scrypt tier from the original scrypt paper — chosen so it comfortably
 * fits Node's default 32MB scrypt maxmem (cost is roughly 128*N*r bytes
 * ≈ 16.7MB here) without needing a custom maxmem override. Revisit if a
 * security review calls for a higher cost tier.
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;

/**
 * NIST 800-63B guidance: favor length over mandatory composition rules
 * (no forced uppercase/digit/symbol requirements — those push people
 * toward predictable substitutions like "Password1!" without meaningfully
 * increasing entropy). A generous minimum length does more for real
 * security than composition theater.
 */
export function validatePasswordStrength(password: string): { valid: boolean; reason?: string } {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { valid: false, reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { valid: false, reason: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.` };
  }
  return { valid: true };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })) as Buffer;

  // Store cost params alongside the hash so they can change later
  // without invalidating already-stored hashes.
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${derivedKey.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }

  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  const salt = Buffer.from(saltHex, "hex");
  const storedHash = Buffer.from(hashHex, "hex");

  const derivedKey = (await scrypt(password, salt, storedHash.length, { N: n, r, p })) as Buffer;

  // timingSafeEqual to avoid leaking hash-match progress via response
  // timing. Both buffers must be equal length first (guaranteed here
  // since we derive to storedHash.length), or timingSafeEqual throws.
  return timingSafeEqual(derivedKey, storedHash);
}
