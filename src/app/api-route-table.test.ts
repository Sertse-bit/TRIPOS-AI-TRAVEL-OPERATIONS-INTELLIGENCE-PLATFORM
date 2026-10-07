import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 32: documentation that cannot drift.
 *
 * docs/API.md publishes a route table. A published table that nobody
 * checks quietly becomes a lie the first time someone renames a route —
 * so this test derives the table from the filesystem (every route.ts
 * under src/app/api) and the methods each file actually exports, then
 * compares the two.
 *
 * It also enforces the project rule that every API route is wrapped in
 * `withApiHandler`, which is what makes the envelope and the request id
 * uniform across all of them.
 */

const APP_ROOT = join(process.cwd(), "src/app");
const API_ROOT = join(APP_ROOT, "api");
const DOC_PATH = join(process.cwd(), "docs", "API.md");
const VERBS = ["DELETE", "GET", "PATCH", "POST", "PUT"] as const;

function findRouteFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findRouteFiles(full, found);
    else if (entry.name === "route.ts") found.push(full);
  }
  return found;
}

/** The methods a route file exports — the app router's own contract. */
function exportedVerbs(source: string): Set<string> {
  const verbs = new Set<string>();
  for (const match of source.matchAll(/export const (GET|POST|PATCH|PUT|DELETE)\b/g)) {
    verbs.add(match[1]);
  }
  return verbs;
}

/** Routes as they exist on disk: path → exported methods. */
function actualRoutes(): Map<string, Set<string>> {
  const routes = new Map<string, Set<string>>();
  for (const file of findRouteFiles(API_ROOT)) {
    const rel = relative(APP_ROOT, file).replace(/\\/g, "/");
    const path = `/${rel.replace(/\/route\.ts$/, "")}`;
    routes.set(path, exportedVerbs(readFileSync(file, "utf8")));
  }
  return routes;
}

/** Rows of the published table in docs/API.md: path → listed methods. */
function documentedRoutes(): Map<string, Set<string>> {
  const routes = new Map<string, Set<string>>();
  for (const line of readFileSync(DOC_PATH, "utf8").split("\n")) {
    const row = /^\| `([A-Z, ]+)` \| `([^`]+)` \|/.exec(line.trim());
    if (!row) continue;
    const path = row[2];
    if (!path.startsWith("/api/")) continue;
    routes.set(
      path,
      new Set(
        row[1]
          .split(",")
          .map((verb) => verb.trim())
          .filter(Boolean),
      ),
    );
  }
  return routes;
}

describe("docs/API.md route table", () => {
  const actual = actualRoutes();
  const documented = documentedRoutes();

  it("discovers a non-trivial API to compare against", () => {
    // Guards the test itself: if the walk broke (renamed directory, empty
    // glob), both sides would be empty and every comparison below would
    // pass vacuously.
    expect(actual.size).toBeGreaterThan(20);
    expect(documented.size).toBe(actual.size);
  });

  it("lists every route that exists, and no route that doesn't", () => {
    const missingFromDocs = [...actual.keys()].filter((path) => !documented.has(path));
    const staleInDocs = [...documented.keys()].filter((path) => !actual.has(path));

    expect(missingFromDocs).toEqual([]);
    expect(staleInDocs).toEqual([]);
  });

  it("lists exactly the methods each route exports", () => {
    const mismatched: string[] = [];
    for (const [path, methods] of actual) {
      const documentedMethods = documented.get(path);
      if (!documentedMethods) continue;
      const sameSize = documentedMethods.size === methods.size;
      const sameMembers = [...methods].every((verb) => documentedMethods.has(verb));
      if (!sameSize || !sameMembers) {
        mismatched.push(
          `${path}: code has [${[...methods].join(", ")}], doc has [${[...documentedMethods].join(", ")}]`,
        );
      }
    }

    expect(mismatched).toEqual([]);
  });

  it("covers every exported method name the router accepts", () => {
    // A route exporting a verb this test doesn't know about would be
    // invisible to the comparison above; pin the vocabulary instead.
    for (const [path, methods] of actual) {
      for (const verb of methods) {
        expect(VERBS, `${path} exports an unrecognized ${verb}`).toContain(verb as never);
      }
      expect(methods.size).toBeGreaterThan(0);
    }
  });

  it("wraps every API route in withApiHandler", () => {
    const unwrapped: string[] = [];
    for (const file of findRouteFiles(API_ROOT)) {
      if (!readFileSync(file, "utf8").includes("withApiHandler")) {
        unwrapped.push(relative(APP_ROOT, file));
      }
    }

    expect(unwrapped).toEqual([]);
  });
});
