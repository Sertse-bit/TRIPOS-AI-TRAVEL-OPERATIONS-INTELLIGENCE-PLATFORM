import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 33 (Final Engineering Audit): the module boundary rule, made
 * executable.
 *
 * AGENTS.md says modules talk to each other only through a public
 * service interface (or a domain event) and never reach into another
 * module's internal files. That was a review discipline until now; this
 * test turns it into a check that fails the build.
 *
 * What counts as a violation: a **value** import in production module
 * code (any .ts file under src/modules, excluding tests) where the
 * module in the specifier differs from the module doing the importing,
 * and the target is not a `*-service.ts` (the public interface each
 * module exposes).
 *
 * What deliberately does not count:
 *   - type-only imports (`import type { … }`, or `type X` specifiers) —
 *     erased at runtime, they carry no coupling;
 *   - a module importing its own files — that is internal composition;
 *   - `*.test.ts` — tests seed fixtures directly (e.g. inserting a
 *     flight-status snapshot the services don't expose a write path for);
 *     a fixture is not a module depending on a module.
 */

const MODULES_ROOT = join(process.cwd(), "src", "modules");
const SRC_ROOT = join(process.cwd(), "src");

function moduleFiles(root: string, found: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) moduleFiles(full, found);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) found.push(full);
  }
  return found;
}

interface CrossModuleImport {
  file: string;
  specifier: string;
  imported: string[];
  viaPublicInterface: boolean;
}

function crossModuleValueImports(): CrossModuleImport[] {
  const imports: CrossModuleImport[] = [];

  for (const file of moduleFiles(MODULES_ROOT)) {
    const owningModule = relative(MODULES_ROOT, file).split("/")[0];
    const source = readFileSync(file, "utf8");

    for (const match of source.matchAll(
      /import\s+(type\s+)?\{([^}]*)\}\s+from\s+"@\/modules\/([^"]+)"/g,
    )) {
      const statementIsTypeOnly = Boolean(match[1]);
      const specifiers = match[2]
        .split(",")
        .map((specifier) => specifier.trim())
        .filter(Boolean);
      const valueSpecifiers = statementIsTypeOnly
        ? []
        : specifiers.filter((specifier) => !/^type\s/.test(specifier));

      const [targetModule, targetFile] = match[3].split("/");
      if (targetModule === owningModule || valueSpecifiers.length === 0) continue;

      imports.push({
        file: relative(process.cwd(), file),
        specifier: match[3],
        imported: valueSpecifiers,
        viaPublicInterface: targetFile.endsWith("-service") || targetFile === "index",
      });
    }
  }

  return imports;
}

describe("module boundary rule (AGENTS.md)", () => {
  it("finds real module code and real cross-module traffic to check", () => {
    // Non-vacuity: an empty walk would make every violation check below
    // pass by proving nothing. The cross-module count is deliberately
    // lower than the total traffic — the rule lets most of it through
    // the service interface, and there has to be some to prove the
    // scanner can see it.
    expect(moduleFiles(MODULES_ROOT).length).toBeGreaterThan(40);

    const all = crossModuleValueImports();
    expect(all.length).toBeGreaterThan(5);
    expect(all.filter((entry) => entry.viaPublicInterface).length).toBeGreaterThan(5);
  });

  it("has no production module importing another module's internals", () => {
    const violations = crossModuleValueImports()
      .filter((entry) => !entry.viaPublicInterface)
      .map(
        (violation) =>
          `${violation.file} -> @/modules/${violation.specifier} [${violation.imported.join(", ")}]`,
      );

    expect(violations).toEqual([]);
  });
});

/**
 * The rule's letter covers modules. Everything *outside* src/modules —
 * the AI agent and tool layers, the auth routes, the resilience layer —
 * also reads module repositories directly today: 16 places, listed
 * below. That is recorded rather than approved. Moving each to a service
 * call would change behaviour in the agent write path (e.g.
 * `createTripRecommendation` also writes the trip event the tool writes
 * itself) during the audit phase, so the honest move is a pinned list:
 * any new outside-module repository import fails this test until it is
 * added here deliberately, and any removal fails it too, so the list can
 * only shrink on purpose.
 */
const PINNED_OUTSIDE_MODULE_REPOSITORY_IMPORTS = [
  "src/ai/agents/currency-agent.ts :: @/modules/trip/currency-snapshot-repository",
  "src/ai/agents/currency-agent.ts :: @/modules/trip/trip-event-repository",
  "src/ai/agents/flight-agent.ts :: @/modules/trip/flight-repository",
  "src/ai/agents/flight-agent.ts :: @/modules/trip/trip-event-repository",
  "src/ai/agents/planning-agent.ts :: @/modules/itinerary/itinerary-repository",
  "src/ai/agents/weather-agent.ts :: @/modules/trip/destination-repository",
  "src/ai/agents/weather-agent.ts :: @/modules/trip/trip-event-repository",
  "src/ai/agents/weather-agent.ts :: @/modules/trip/weather-snapshot-repository",
  "src/ai/tools/action-tools.ts :: @/modules/notification/notification-repository",
  "src/ai/tools/action-tools.ts :: @/modules/trip/recommendation-repository",
  "src/ai/tools/action-tools.ts :: @/modules/trip/trip-event-repository",
  "src/ai/tools/provider-tools.ts :: @/modules/trip/destination-repository",
  "src/ai/tools/provider-tools.ts :: @/modules/trip/flight-repository",
  "src/app/api/auth/login/route.ts :: @/modules/auth/user-repository",
  "src/app/api/auth/register/route.ts :: @/modules/auth/user-repository",
  "src/infrastructure/resilience.ts :: @/modules/observability/api-health-repository",
];

/** All .ts/.tsx files outside src/modules, excluding tests. */
function outsideModuleFiles(root: string, found: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (full === MODULES_ROOT) continue;
      outsideModuleFiles(full, found);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
      found.push(full);
    }
  }
  return found;
}

describe("outside-module repository imports (recorded debt)", () => {
  it("has exactly the repository imports recorded in this file", () => {
    const actual: string[] = [];

    for (const file of outsideModuleFiles(SRC_ROOT)) {
      const source = readFileSync(file, "utf8");
      const re = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+"@\/modules\/([^\"]*repository)"/g;
      for (const match of source.matchAll(re)) {
        const specifiers = match[2]
          .split(",")
          .map((specifier) => specifier.trim())
          .filter(Boolean);
        const values = match[1] ? [] : specifiers.filter((specifier) => !/^type\s/.test(specifier));
        if (values.length === 0) continue;
        actual.push(`${relative(process.cwd(), file)} :: @/modules/${match[3]}`);
      }
    }

    actual.sort();
    expect(actual).toEqual([...PINNED_OUTSIDE_MODULE_REPOSITORY_IMPORTS].sort());
  });
});
