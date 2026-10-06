# TripOS — Accessibility

## Status: Phase 25 (Accessibility) Complete

The UI was built themed and legible-looking, but it had never been
measured. Measuring it found real failures — including one that makes the
whole dark theme unreadable on a dark-mode machine. This document records
what was broken, what changed, how it is verified, and what is still not
covered.

## What was actually wrong

Found by computing WCAG contrast ratios for every palette class the UI
uses, against every surface the UI renders text on (the palette inverts in
dark mode, so a token has to be checked in both themes):

| Finding                                                             | Consequence                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `dark:text-navy-100` (53 uses) resolved to `#1b2738` on `#1a1714`   | **1.06:1** — every heading, card title, and value in dark mode was effectively invisible                |
| `text-sand-500` (57 uses) on card surfaces                          | 2.88:1–3.30:1, under the 4.5:1 AA floor for body text in both themes                                    |
| `text-sand-400` (24 uses)                                           | 1.92:1–2.20:1 — the same, worse                                                                         |
| `dark:text-alert-500` on the dark hover surface                     | 4.45:1 — a hair under AA                                                                                |
| `bg-navy-50`, `border-navy-300`                                     | Not tokens in `globals.css` at all, so Tailwind generated nothing: dead classes that looked deliberate  |
| No skip link, no `aria-current`, no `aria-busy`, unannounced errors | Keyboard users tabbed through the whole nav on every page; submit results and failures were visual-only |

## What changed

**Colour.** Muted text now uses the `sand-600` step in both themes (4.51:1
worst case in light, 4.82:1 in dark) instead of the two decorative steps
below it; dark-mode strong text uses `sand-800` (9.49:1 worst case). Two
dark-mode tokens were nudged one step so they clear AA on _every_ surface
they can land on — `--navy-500` (`#5589bf` → `#6198cf`, was 3.87:1 on the
dark hover surface) and `--alert-500` (`#e06f54` → `#e5765c`, was 4.45:1).
Light mode is otherwise untouched; the two dead classes were replaced with
real tokens.

**Structure.** `src/app/layout.tsx` now ships a skip link as the first
focusable element of the document, and each shell's `<main>` carries
`id="main-content"` as its target. Landmarks (`header`/`nav`/`main`/
`footer`) already existed; the nav gained an accessible name
(`aria-label="Primary"`) and, via a small client island, exactly one
`aria-current="page"` — the longest matching nav href, so a trip detail
page marks the section root rather than every ancestor.

**Interaction.** `Button` takes a `busy` prop that sets `aria-busy` and
does not disable-then-render-silently; the submit buttons across the app
use it. Form messages are live regions (`role="alert"` for errors,
`role="status"` for successes), `InlineError` is an alert, and `TextField`
pairs an explicit `label[for]`/`input[id]` with `aria-invalid` +
`aria-describedby` when it is given a field error. Decorative SVGs are
`aria-hidden`. A `prefers-reduced-motion` block neutralises the hover
transitions, and a viewport declaration was added.

## How it is verified

`src/app/accessibility.test.ts` (11 tests) is the permanent guard. It

- implements WCAG relative luminance/contrast and pins it to the known
  anchors (black-on-white = 21:1, the `#767676` boundary);
- parses both theme token maps out of `globals.css`, asserts the eight
  status-chip pairs clear AA, and asserts every palette class used
  anywhere in `src/app` + `src/components` resolves to a **declared**
  token (this is what catches a `bg-navy-50`-style dead class);
- computes, for every text class in the source, the worst-case contrast
  against the surfaces text is rendered on in that theme, and fails with
  the offenders listed;
- asserts the shells' `main#main-content`, the skip link being before the
  content it skips, the focus-ring and reduced-motion rules, and the nav
  current-page rule (including the sibling-prefix case, `/trips/auditx`).

Two sanity assertions (files scanned > 20, palette classes seen > 100)
exist so the scan cannot pass by finding nothing.

## Known limitations (honest)

- **No browser-based audit was run.** The sandbox has no Chrome/Chromium
  and no DOM test environment, so there is no axe run, no focus-order
  verification, no tab-trap/roving-tabindex testing, and no measurement of
  what a screen reader actually announces. Everything above is static
  analysis plus rendered-HTML inspection of the live app (`lang`, skip
  link, `aria-current`, `label[for]`, the new tokens present in the served
  CSS).
- **Contrast is checked for the palette tokens only** — text using
  `text-white` on coloured buttons, gradients, and any colour built at
  runtime are outside the scan.
- **Dynamic class names cannot be evaluated** by a literal scan; the
  sanity assertions make that limitation visible rather than silent.
- **Not audited:** document viewer content, third-party provider copy
  rendered into the UI, and any content a user uploads.
- Form _field-level_ errors are now supportable (`TextField error`) and
  announced, but most forms still surface a single form-level message
  rather than pointing at the offending field; wiring per-field validation
  across the API-error paths remains open.
