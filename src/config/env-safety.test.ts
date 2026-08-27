import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * "Never expose external API credentials to the browser" (brief, Phase 4)
 * is stated as a rule everywhere in this codebase's docs. This test makes
 * it a checked fact instead of a promise: it fails the suite (and
 * therefore CI, once Phase 31 wires this in) if that rule is ever
 * violated, rather than relying on every future PR remembering to check
 * by hand.
 */

const SECRET_KEY_PATTERN = /(API_KEY|SECRET|PASSWORD|TOKEN)/i;
const PROJECT_ROOT = join(__dirname, "..", "..");

function walkSourceFiles(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".next", ".git", "dist", "build"].includes(entry)) continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walkSourceFiles(fullPath, results);
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
      results.push(fullPath);
    }
  }
  return results;
}

describe("env safety", () => {
  it("never defines a NEXT_PUBLIC_ variable that looks like a secret, anywhere in src/", () => {
    const files = walkSourceFiles(join(PROJECT_ROOT, "src"));
    const offenders: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      const matches = content.matchAll(/NEXT_PUBLIC_[A-Z0-9_]*/g);
      for (const match of matches) {
        if (SECRET_KEY_PATTERN.test(match[0])) {
          offenders.push(`${file}: ${match[0]}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("env.ts never re-exports a raw provider key under a NEXT_PUBLIC_ name", () => {
    const envFile = readFileSync(join(PROJECT_ROOT, "src", "config", "env.ts"), "utf-8");
    // Checks for an actual declaration or access pattern (a zod schema
    // field, a process.env/env property access), not a bare substring —
    // a bare-substring version of this check previously false-positived
    // on this very file's own comment *explaining* that it defines no
    // such variables, since that sentence itself contains the token.
    expect(envFile).not.toMatch(/(?:process\.env|env)\.NEXT_PUBLIC_/);
    expect(envFile).not.toMatch(/NEXT_PUBLIC_\w*\s*:/);
  });

  it(".env.example documents variable names only -- no populated secret-shaped values", () => {
    const exampleFile = readFileSync(join(PROJECT_ROOT, ".env.example"), "utf-8");
    const offenders: string[] = [];

    for (const line of exampleFile.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [key, ...rest] = trimmed.split("=");
      const value = rest.join("=").trim();
      if (SECRET_KEY_PATTERN.test(key) && value.length > 0) {
        offenders.push(trimmed);
      }
    }

    expect(offenders).toEqual([]);
  });
});
