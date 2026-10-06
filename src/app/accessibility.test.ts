import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { currentNavHref, TRIPS_NAV } from "@/app/trips/nav-links";

/**
 * Accessibility guards (Phase 25). These are static checks over the
 * source and the theme, not a browser audit: nothing here can see focus
 * order or a rendered layout. What it CAN do is stop the two failures
 * this phase found from coming back —
 *
 *   1. text that does not meet WCAG AA contrast on the surfaces it is
 *      actually rendered against (the palette inverts in dark mode, so a
 *      token that is legible in one theme can be invisible in the other);
 *   2. palette classes that reference a token globals.css never defines,
 *      which Tailwind silently drops.
 *
 * The scan is deliberately literal (class tokens, whitespace-split), so
 * it cannot be fooled by a dynamic class name — and equally cannot
 * evaluate one. Anything built at runtime is out of its reach; the
 * sanity assertions at the bottom keep that limitation visible by
 * failing if the scan stops finding real tokens.
 */

// --- WCAG 2.x relative luminance and contrast ratio -------------------

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = hex
    .replace("#", "")
    .match(/../g)!
    .map((pair) => channel(parseInt(pair, 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const AA_NORMAL_TEXT = 4.5;

describe("contrast ratio math", () => {
  it("matches the known WCAG anchors", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // The classic boundary pair: #767676 on white is the darkest grey that
    // still clears 4.5:1; one step darker must therefore pass.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.6);
  });
});

// --- theme tokens, read from the one place they are defined -----------

const GLOBALS_CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

function parseTokens(css: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of css.matchAll(/--([a-z]+(?:-\d+)?):\s*(#[0-9a-fA-F]{6});/g)) {
    map.set(match[1], match[2].toLowerCase());
  }
  return map;
}

const darkBlockStart = GLOBALS_CSS.indexOf("@media (prefers-color-scheme: dark)");
const LIGHT_TOKENS = parseTokens(GLOBALS_CSS.slice(0, darkBlockStart));
const DARK_TOKENS = parseTokens(GLOBALS_CSS.slice(darkBlockStart));

/**
 * The surfaces text is rendered on in each theme: page background, card,
 * subtle panel, and (dark mode only) the hover surface a secondary
 * button or nav item shows under its text. Chips are excluded here
 * because their text sits on a tinted badge background, checked pairwise
 * below instead — a chip's tint is not a surface for body text.
 */
const LIGHT_SURFACES = ["background", "sand-50", "sand-100"] as const;
const DARK_SURFACES = ["background", "sand-50", "sand-100", "sand-200"] as const;
/** `bg-white` is used for cards in light mode and has no token. */
const LIGHT_WHITE = "#ffffff";

/** Foreground/background pairs the tinted status chips actually render. */
const CHIP_PAIRS: Array<[string, string, string]> = [
  ["light", "navy-700", "navy-100"],
  ["light", "ok-700", "ok-100"],
  ["light", "warn-700", "warn-100"],
  ["light", "alert-700", "alert-100"],
  ["dark", "navy-500", "navy-100"],
  ["dark", "ok-500", "ok-100"],
  ["dark", "warn-500", "warn-100"],
  ["dark", "alert-500", "alert-100"],
];

function tokenHex(mode: "light" | "dark", name: string): string {
  const map = mode === "light" ? LIGHT_TOKENS : DARK_TOKENS;
  const value = map.get(name) ?? (mode === "light" ? LIGHT_TOKENS.get(name) : undefined);
  if (!value) throw new Error(`globals.css defines no token --${name} (${mode})`);
  return value;
}

function minRatioAgainstSurfaces(mode: "light" | "dark", hex: string): number {
  const surfaces =
    mode === "light"
      ? [...LIGHT_SURFACES.map((name) => tokenHex("light", name)), LIGHT_WHITE]
      : DARK_SURFACES.map((name) => tokenHex("dark", name));
  return Math.min(...surfaces.map((surface) => contrastRatio(hex, surface)));
}

describe("theme tokens", () => {
  it("parses both themes from globals.css (the scan is not vacuous)", () => {
    expect(LIGHT_TOKENS.size).toBeGreaterThan(20);
    expect(DARK_TOKENS.size).toBeGreaterThan(15);
    expect(tokenHex("light", "sand-600")).not.toBe(tokenHex("dark", "sand-600"));
  });

  it("every declared chip pair clears AA", () => {
    const failures = CHIP_PAIRS.map(([mode, fg, bg]) => {
      const ratio = contrastRatio(
        tokenHex(mode as "light" | "dark", fg),
        tokenHex(mode as "light" | "dark", bg),
      );
      return { mode, fg, bg, ratio };
    }).filter((pair) => pair.ratio < AA_NORMAL_TEXT);

    expect(
      failures.map((f) => `${f.mode}: text-${f.fg} on bg-${f.bg} = ${f.ratio.toFixed(2)}:1`),
    ).toEqual([]);
  });
});

// --- the source scan -------------------------------------------------

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const PALETTES = "navy|sand|terra|ok|warn|alert";
const TOKEN_CLASS = new RegExp(
  `^(?:[a-z-]+:)*?(?:text|bg|border|ring|divide|from|via|to)-(${PALETTES})-(\\d+)$`,
);
const CLASS_TOKEN = /[A-Za-z0-9:/._%[\]-]+/g;

interface PaletteUse {
  file: string;
  className: string;
  mode: "light" | "dark";
  palette: string;
  shade: string;
}

const SOURCE_DIRS = ["src/app", "src/components"];
const paletteUses: PaletteUse[] = [];
const scannedFiles: string[] = [];

for (const dir of SOURCE_DIRS) {
  for (const file of collectSourceFiles(join(process.cwd(), dir))) {
    scannedFiles.push(file);
    const content = readFileSync(file, "utf8");
    for (const token of content.match(CLASS_TOKEN) ?? []) {
      const match = TOKEN_CLASS.exec(token);
      if (!match) continue;
      paletteUses.push({
        file: file.replace(`${process.cwd()}/`, ""),
        className: token,
        mode: token.includes("dark:") ? "dark" : "light",
        palette: match[1],
        shade: match[2],
      });
    }
  }
}

describe("palette classes in the UI", () => {
  it("all reference tokens that globals.css actually defines", () => {
    const unknown = paletteUses
      .filter((use) => {
        try {
          tokenHex(use.mode, `${use.palette}-${use.shade}`);
          return false;
        } catch {
          return true;
        }
      })
      .map((use) => `${use.file}: ${use.className}`);

    expect(unknown).toEqual([]);
  });

  it("text colours clear WCAG AA on the surfaces they render on", () => {
    const failures = new Map<string, { min: number; sample: string }>();
    for (const use of paletteUses) {
      if (!use.className.endsWith(`text-${use.palette}-${use.shade}`)) continue;
      const hex = tokenHex(use.mode, `${use.palette}-${use.shade}`);
      const min = minRatioAgainstSurfaces(use.mode, hex);
      if (min >= AA_NORMAL_TEXT) continue;
      const key = `${use.mode}: text-${use.palette}-${use.shade} = ${min.toFixed(2)}:1`;
      const seen = failures.get(key);
      if (seen) seen.sample += `, ${use.file}`;
      else failures.set(key, { min, sample: use.file });
    }

    expect([...failures.entries()].map(([key, value]) => `${key} (${value.sample})`)).toEqual([]);
  });

  it("scanned a non-trivial number of files and classes", () => {
    expect(scannedFiles.length).toBeGreaterThan(20);
    expect(paletteUses.length).toBeGreaterThan(100);
  });
});

// --- structural semantics -------------------------------------------

describe("page structure", () => {
  const shells = ["src/app/trips/layout.tsx", "src/components/auth-shell.tsx", "src/app/page.tsx"];

  it("every shell marks its main region as the skip-link target", () => {
    for (const shell of shells) {
      const content = readFileSync(join(process.cwd(), shell), "utf8");
      expect(content, shell).toContain('<main id="main-content"');
    }
  });

  it("the root layout ships a skip link as the first focusable element", () => {
    const layout = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");
    expect(layout).toContain('href="#main-content"');
    expect(layout).toContain("sr-only focus:not-sr-only");
    expect(layout).toContain('lang="en"');
    // The anchor must come before the page content it skips past.
    expect(layout.indexOf('href="#main-content"')).toBeLessThan(layout.indexOf("{children}"));
  });

  it("keeps a visible focus ring and honours reduced-motion", () => {
    // Focus must never be invisible, and hover transitions must not fight
    // an OS-level request for less motion.
    expect(GLOBALS_CSS).toContain(":focus-visible");
    expect(GLOBALS_CSS).toContain("@media (prefers-reduced-motion: reduce)");
    expect(GLOBALS_CSS).toContain("transition-duration: 0.01ms");
  });

  it("the trips nav marks exactly one current page", () => {
    expect(currentNavHref("/trips")).toBe("/trips");
    expect(currentNavHref("/trips/audit")).toBe("/trips/audit");
    expect(currentNavHref("/trips/observability")).toBe("/trips/observability");
    // A page with no entry of its own keeps the section root current.
    expect(currentNavHref("/trips/9c1f-whatever")).toBe("/trips");
    // A sibling path that merely shares a prefix is not a match.
    expect(currentNavHref("/trips/auditx")).toBe("/trips");
    expect(currentNavHref("/login")).toBeNull();
    expect(currentNavHref("/")).toBeNull();
  });

  it("nav targets are unique and inside the trips shell", () => {
    const hrefs = TRIPS_NAV.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs.every((href) => href === "/trips" || href.startsWith("/trips/"))).toBe(true);
  });
});
