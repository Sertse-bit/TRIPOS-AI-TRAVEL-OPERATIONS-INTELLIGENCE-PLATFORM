import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 32: the documentation index stays true.
 *
 * An index is only worth having while it is complete — a doc added next
 * month and missing from it is the same slow drift as a stale route
 * table. Two properties: every document in docs/ is listed, and every
 * link in the index resolves to a file that exists.
 */

const REPO_ROOT = process.cwd();
const DOCS_DIR = join(REPO_ROOT, "docs");
const INDEX_PATH = join(DOCS_DIR, "README.md");

function documents(): string[] {
  return readdirSync(DOCS_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort();
}

describe("docs/README.md index", () => {
  it("lists every document in docs/", () => {
    const index = readFileSync(INDEX_PATH, "utf8");
    // Compare link *targets* (basename), not prose: the filename has to
    // be reachable from the index, not merely mentioned in a sentence.
    const linked = new Set(
      [...index.matchAll(/\]\(([^)]+\.md)\)/g)].map((match) => match[1].split("/").pop()),
    );
    const unlisted = documents().filter((name) => name !== "README.md" && !linked.has(name));

    expect(unlisted).toEqual([]);
  });

  it("links only to files that exist", () => {
    const index = readFileSync(INDEX_PATH, "utf8");
    const broken: string[] = [];

    for (const match of index.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (target.startsWith("http")) continue;
      const resolved = target.startsWith("/")
        ? join(REPO_ROOT, target)
        : resolve(dirname(INDEX_PATH), target);
      if (!existsSync(resolved)) broken.push(target);
    }

    expect(broken).toEqual([]);
  });

  it("documents documents, not source files", () => {
    // The index's table cells are the only prose claim each row makes;
    // an empty description is as useless as a missing row.
    const index = readFileSync(INDEX_PATH, "utf8");
    const rows = index.split("\n").filter((line) => /^\| \[.*\.md\]\(/.test(line));
    expect(rows.length).toBeGreaterThan(4);
    for (const row of rows) {
      expect(row.split("|")[2]?.trim().length ?? 0).toBeGreaterThan(10);
    }
  });
});
