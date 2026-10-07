import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 33 (Final Engineering Audit): the suite's own integrity.
 *
 * AGENTS.md's rule is that tests genuinely pass and are never skipped.
 * The two ways that rule usually erodes are silent: `.skip`/`todo` (a
 * failing test that stops being counted) and `.only` (a passing run that
 * silently excludes everything else). Both are invisible in the summary
 * line of a green run, so a test asserts their absence instead of hoping
 * nobody adds one.
 */

const SRC_ROOT = join(process.cwd(), "src");

function testFiles(root: string, found: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) testFiles(full, found);
    else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) found.push(full);
  }
  return found;
}

describe("test suite integrity", () => {
  const files = testFiles(SRC_ROOT);

  it("discovers the whole suite", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it("contains no skipped, todo, or focused tests", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const relativePath = relative(process.cwd(), file);

      // Matched as whole method calls so a `.skip` in prose or a
      // `user.skip()` in unrelated code doesn't trip it.
      for (const pattern of [
        /\b(?:it|test|describe)\s*\.\s*only\s*\(/,
        /\b(?:it|test|describe)\s*\.\s*skip\s*\(/,
        /\b(?:it|test|describe)\s*\.\s*todo\s*\(/,
      ]) {
        if (pattern.test(source)) offenders.push(relativePath);
      }
    }

    expect([...new Set(offenders)]).toEqual([]);
  });

  it("every test file actually contains tests", () => {
    const empty = files.filter(
      (file) => !/\b(?:it|test|describe)\s*\(/.test(readFileSync(file, "utf8")),
    );

    expect(empty.map((file) => relative(process.cwd(), file))).toEqual([]);
  });
});
