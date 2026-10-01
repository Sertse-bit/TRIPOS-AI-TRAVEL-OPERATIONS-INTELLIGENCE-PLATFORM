# TripOS — Build Progress

This document is updated after every phase. Do not skip phases without an
explicit stop-and-approve checkpoint.

---

## Phase 0 — Repository Audit

**Status:** Complete

**Implemented:**

- Cloned and inspected the target GitHub repository.
- Confirmed the repository is empty (no commits, no files, unborn `main`
  branch) — this is a greenfield project, not an existing codebase to
  refactor.
- Documented proposed technology stack and target architecture in
  `docs/ARCHITECTURE.md` for approval before scaffolding.

**Files changed:**

- `docs/ARCHITECTURE.md` (created)
- `docs/BUILD_PROGRESS.md` (created)

**Tests:** N/A — no code exists yet.

**Known limitations:**

- No existing code, so the "existing strengths / problems / reusable
  components" portion of the audit is not applicable; replaced with a
  stack-decision proposal instead.

**Credential status (update):**

- Real API keys received for 11 providers: Aviationstack, Weatherstack,
  Fixer, ExchangeRate, IPstack, Numverify, Zenserp, Filestack,
  Screenshotlayer, Mailboxlayer, and Marketstack.
- `.env.example` committed with variable names only (no values).
  `.env.local` holds real values locally and is git-ignored — see
  `.gitignore`. Real values are never committed.
- **Resolved 2026-08-24:** `ZENSERP_API_KEY` was corrected. The original
  value was a duplicate of `AVIATIONSTACK_API_KEY` (copy/paste error); the
  replacement is UUID-formatted, consistent with Zenserp's real key
  convention, and confirmed unique against all 11 stored credentials.
  Not live-tested (sandbox network egress to provider domains is blocked,
  per the constraint noted above) — format and uniqueness checks pass,
  live validity will surface whenever the Research Agent (Phase 13)
  actually calls it.
- **Unmapped:** `MARKETSTACK_API_KEY` (stock market data) has no identified
  use case in TripOS. Left unused pending a real justification, per the
  "no dependencies without justification" rule.
- **Sandbox constraint:** this build environment's network egress is
  allowlisted to package registries and GitHub only; third-party provider
  domains (weatherstack.com, aviationstack.com, etc.) are blocked
  (confirmed empirically: `host_not_allowed`). Provider adapters will be
  written against the real APIs, but live calls can't be smoke-tested from
  inside this sandbox — automated tests will mock at the HTTP layer
  (per Phase 6/27), and live verification happens wherever the app is
  actually run.

**Next phase:** Phase 1 — System Architecture (pending approval of the
stack proposal in `docs/ARCHITECTURE.md`).

---

## Phase 1 — System Architecture

**Status:** Complete

**Implemented:**

- Bounded responsibilities and service boundaries for every module, plus an
  enforceable boundary rule (modules only interact via public service
  interfaces or domain events — no reaching into another module's tables).
- System container diagram (Mermaid).
- Data flow (trip lifecycle — how snapshots accumulate and feed risk).
- Request flow (Mermaid sequence diagram — command-bar question end to
  end through the tool layer and back).
- Event flow (flight change → risk recompute → recommendation →
  notification, with idempotency keyed on entity id + snapshot id).
- AI tool flow with concrete execution limits (max 8 tool calls/run, 30s
  wall-clock cap, no agent-to-agent recursion).
- Error propagation policy, including the fixed success/error JSON
  envelope shape.
- Authentication flow (Mermaid sequence diagram) — decided on Auth.js with
  database-backed sessions (not JWT) specifically so sessions are
  server-side revocable.
- Document-processing flow at the architecture level (deep pipeline detail
  deferred to Phase 14–15 on purpose).
- Explicit "deferred to later phases" list so Phase 1 doesn't overreach
  into implementation decisions that belong to later phases.

**Files changed:**

- `docs/ARCHITECTURE.md` — restructured and substantially expanded (all of
  the above added as new sections 5–14; old placeholder ASCII diagram and
  "open questions" section replaced with a decisions log).

**Tests:** N/A (no application code yet — this phase is design-only, per
the brief). All 8 Mermaid diagrams were syntax-checked programmatically
(bracket balance + subgraph/alt block closure) before commit rather than
just visually reviewed.

**Known limitations:**

- Auth strategy is decided at the architecture level (Auth.js, DB
  sessions) but not yet implemented — that's Phase 4.
- `ZENSERP_API_KEY` verification is still outstanding (see Phase 0 entry).

**Next phase:** Phase 2 — Project Foundation (TypeScript strict mode,
environment config/validation, error handling, logging, API response
conventions, initial folder scaffold, linting, foundational tests).

---

## Phase 2 — Project Foundation

**Status:** Complete

**Implemented:**

- Next.js 16 (App Router) + TypeScript strict mode scaffold, pnpm-managed.
- Feature-oriented folder structure under `src/` per ARCHITECTURE.md
  Section 3 (`modules/`, `shared/`, `infrastructure/`, `config/`,
  `database/`, `ai/`, `workers/`, `events/`, `integrations/`).
- `src/config/env.ts` — Zod-validated environment config. Fails fast at
  startup (proven: build genuinely failed when `DATABASE_URL`/`AUTH_SECRET`
  were missing, then passed once they were set — this is the intended
  behavior, not a bug).
- `src/shared/errors.ts` — typed `AppError` hierarchy
  (Validation/Unauthenticated/Unauthorized/NotFound/Conflict/Provider/
  RateLimited), matching the HTTP status mapping fixed in
  `docs/ARCHITECTURE.md` Section 11.
- `src/infrastructure/logger.ts` — structured logging (pino), redacts
  secrets/tokens/passwords by default, request-scoped child loggers.
- `src/shared/api-response.ts` — `withApiHandler` wrapper enforcing the
  success/error envelope from ARCHITECTURE.md Section 11 on every route;
  unexpected errors are logged in full server-side but never leak detail
  to the client.
- `/api/health` route — real end-to-end proof: booted the production
  server and curled it live (see Test Results). Reports actual configured
  provider availability, not a hardcoded status.
- ESLint + Prettier (`eslint-config-prettier` wired in to avoid rule
  conflicts) + Husky pre-commit hook running `lint-staged`.
- Vitest configured with path aliases; foundational test suite for the
  error hierarchy (6 tests).
- Removed the Next.js default marketing boilerplate (Google Fonts import,
  demo page, unused SVGs) — replaced with an honest placeholder page and
  a system-font stack, since Google Fonts' CDN isn't reachable from this
  sandbox's network allowlist (same class of restriction as the travel
  provider APIs).
- Replaced the scaffold's auto-generated generic `CLAUDE.md`/`AGENTS.md`
  with a project-specific one describing TripOS's actual conventions,
  non-negotiable rules, and local dev commands.
- Installed real local PostgreSQL 16 + pgvector 0.6.0 + Redis in this
  sandbox (via apt, from the allowed Ubuntu mirrors) so later phases can
  be tested against genuine running infrastructure instead of assumed.

**Files changed:** `package.json`, `tsconfig.json` (from scaffold, path
aliases confirmed), `eslint.config.mjs`, `.prettierrc.json`,
`vitest.config.ts`, `vitest.setup.ts`, `.husky/pre-commit`,
`src/config/env.ts`, `src/shared/errors.ts`, `src/shared/errors.test.ts`,
`src/shared/api-response.ts`, `src/infrastructure/logger.ts`,
`src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`,
`src/app/api/health/route.ts`, `AGENTS.md`, `.env.example` (new vars
documented), `.env.local` (real local values, not committed).

**Tests:**

- `pnpm typecheck` → 0 errors
- `pnpm lint` → 0 errors, 0 warnings
- `pnpm test` → 6/6 passing
- `pnpm build` → succeeded (initially failed correctly on missing env
  vars, then succeeded once local config was completed — treated as a
  positive result, not a bug, since that's exactly what fail-fast config
  validation is for)
- `pnpm start` + live `curl localhost:3000/api/health` → real response
  with a real request ID, correlated with the structured log line the
  server actually emitted for that request

**Known limitations:**

- No database schema yet (Phase 3) — `@prisma/client` is installed but
  unused until then.
- Two informational Vitest/Vite warnings about future config deprecations
  (native tsconfig-paths resolution, ESM config loading) — non-blocking,
  not errors, left as-is for now rather than spending phase time on cosmetic
  warnings with 30+ phases remaining.

**Next phase:** Phase 3 — Database Architecture.

---

## Phase 3 — Database Architecture

**Status:** Complete

**Implemented:**

- Full `prisma/schema.prisma`: 17 tables (15 from the brief + 2 justified
  additions — `flight_status_snapshots`, `sessions`), 8 enums, all
  relations, indexes, and the `pgvector` extension wired in for
  `document_chunks.embedding`.
- `docs/DATABASE.md` — ERD (Mermaid `erDiagram`), rationale for every
  non-obvious design decision, and an honest "known gaps" section.
- `prisma/seed.ts` — real seed script against the Prisma Client API.

**Sandbox limitation (documented in full in `docs/DATABASE.md`):**
Prisma's CLI (`generate`/`migrate`/`validate`) fetches its schema-engine
binary from `binaries.prisma.sh` at runtime. That domain isn't in this
sandbox's network allowlist — confirmed on both Prisma 7 and Prisma 6, so
it isn't a version-specific issue, and confirmed it isn't a
locally-cached-binary problem either (no engine binaries exist anywhere
in `node_modules` prior to the failed fetch). This is sandbox-only: a
normal dev machine, CI runner, or Docker build has standard internet
access and will run these commands without issue.

Given that, the schema was verified a different way: hand-translated into
equivalent raw SQL DDL and applied directly to a **live, local PostgreSQL
16 + pgvector 0.6.0** instance (installed via `apt` from the allowed
Ubuntu mirrors — zero external network dependency at runtime). This is
schema verification via real database execution, not a substitute for
Prisma specifically, but a genuine test of the relational design itself.

**Tests (all executed for real against the live database, not asserted):**

- All 17 tables + 8 enums + every index (including the `hnsw` vector
  index) created with zero errors.
- Full realistic insert chain across all 13 populated tables: user → trip
  → destination → flight → 2 append-only flight status snapshots →
  weather snapshot → currency snapshot → document → document chunk (real
  1536-dim vector) → risk assessment → recommendation → trip event.
- `trip_events.dedupe_key` unique constraint **correctly rejected** a
  duplicate insert, proving the Phase 1 idempotency design holds at the
  database level, not just on paper.
- Real pgvector cosine-distance query (`<=>`) against the HNSW index
  executed and returned a result.
- `ON DELETE CASCADE`: deleting the test trip correctly cascaded through
  every dependent row, confirmed via row counts before/after, while
  leaving the owning user intact.
- Test data cleaned up afterward — the live dev database is empty going
  into Phase 4.

**Known limitations:**

- No `prisma/migrations/` directory yet — the first real migration will
  be generated wherever this next runs with normal internet access.
- No DB-level `CHECK` constraints on `risk_score`/`confidence` ranges yet
  (application-level only) — see `docs/DATABASE.md` known gaps.
- `prisma/seed.ts` targets the real Prisma Client API correctly but
  wasn't executed end-to-end itself (it needs `prisma generate` first);
  the data shape it produces was verified via the raw SQL pass instead.

**Next phase:** Phase 4 — Authentication & Security Foundation.

---

## Phase 4 — Authentication & Security Foundation

**Status:** Complete

**Implemented:**

- Credentials-based auth, hand-rolled rather than via `next-auth`/Auth.js
  — see the 2026-08-25 decisions-log entry in `docs/ARCHITECTURE.md` for
  why (the Phase 3 `sessions` table stores a token hash, which doesn't
  match Auth.js's official adapter contract).
- **Interim data-access approach**: since Prisma Client can't be
  generated in this sandbox (Phase 3), `src/modules/auth/*-repository.ts`
  use `pg` directly against the identical schema, isolated behind a
  repository interface so migrating to Prisma Client later — once
  `prisma generate` can run in a normal environment — is a contained
  change, not a rewrite of anything that calls them.
- `password.ts` — Node built-in `scrypt` (N=16384, r=8, p=1; OWASP-acceptable,
  zero native-compiled dependencies), NIST 800-63B-style length-based
  strength policy (12–128 chars, no composition-rule theater).
- `session.ts` — random 32-byte token, SHA-256-hashed for storage
  (fast hash, deliberately not scrypt — a session token is already
  high-entropy, nothing to brute-force), httpOnly/sameSite=lax cookie,
  30-day expiry.
- `access-control.ts` — `requireAuth()` / `requireRole()`. Resource-level
  ownership checks deliberately deferred to each domain module as built
  (Phase 7+), not built prematurely here.
- `rate-limit.ts` — Redis fixed-window limiter, fails open if Redis is
  unreachable (documented tradeoff: an auth outage is worse than a
  temporary loss of brute-force protection).
- `file-validation.ts` — magic-byte sniffing via `file-type`, not
  trusting client-supplied MIME type; built now per Phase 4's explicit
  ask, but the actual upload route is Phase 14's job.
- Routes: `/api/auth/{register,login,logout,me}`. Login rate-limited by
  both IP and email; timing-safe on the "user doesn't exist" path via a
  cached dummy hash so it costs the same as a real wrong-password check.
- `next.config.ts` — security headers (X-Frame-Options, CSP, etc.).
- `docs/SECURITY.md` — full writeup of every decision and honest known
  gaps (no 2FA, no email verification flow yet, no DB-level range
  constraints, passport-number encryption-at-rest still outstanding).
- `env-safety.test.ts` — automated, not just documented: fails the suite
  if any secret-shaped env var ever gets a `NEXT_PUBLIC_` prefix.

**Two real bugs found by tests, not inspection, and fixed:**

1. Phase 2's `AppError` had `Object.setPrototypeOf(this, AppError.prototype)`
   in its base constructor — a fix for pre-ES2015 `class extends Error`
   transpilation that this ES2017-targeting project doesn't need, and
   which actively broke things: it reset every subclass instance's
   prototype back to `AppError.prototype`, so `instanceof AppError` passed
   while `instanceof RateLimitedError` (or any specific subclass) silently
   failed. Caught by `rate-limit.test.ts` expecting
   `.rejects.toBeInstanceOf(RateLimitedError)`. Fixed; added a regression
   test in `errors.test.ts` checking every subclass specifically.
2. `env-safety.test.ts` itself had a false positive: its own bare
   substring check for `NEXT_PUBLIC_` matched against `env.ts`'s comment
   _explaining_ that no such variable exists there. Fixed by checking for
   actual declaration/access patterns instead of bare text.
3. `withApiHandler`'s first design made the forwarded request type generic
   (defaulting to `undefined`), which broke Next.js's own route-type
   validator for any handler not explicitly parameterizing it — caught by
   `pnpm typecheck`, fixed by always typing it as `NextRequest` (what
   Next.js actually always passes).
4. Node's `crypto.scrypt`, wrapped in `promisify()`, has its TypeScript
   overload resolved to the wrong (no-options) signature by default —
   caught by `pnpm typecheck`, fixed with an explicit type annotation
   selecting the correct overload rather than losing type safety with `any`.

**Tests — all executed for real:**

- `pnpm typecheck` → 0 errors
- `pnpm lint` → 0 errors, 0 warnings
- `pnpm test` → 31/31 passing (added: password hashing x9, rate limiting
  x4 against real Redis, file validation x8 against real magic bytes,
  env-safety x3, plus the errors.ts regression test)
- `pnpm build` → succeeded, all 5 auth routes correctly registered as
  dynamic
- **Full live end-to-end auth flow**, booted server + real Postgres,
  9-step curl sequence: register (200, no passwordHash leaked) → duplicate
  register (409) → weak password (400, exact message) → authenticated
  `/me` (200) → unauthenticated `/me` (401) → wrong-password login (401,
  generic message) → correct login (200, new session) → logout (200) →
  `/me` after logout (**401 — proves the session was actually revoked
  server-side, not just that a cookie was cleared client-side**, the core
  justification for DB-backed sessions over JWT).
- Security headers confirmed present via live `curl -I`.
- Rate limiting confirmed to trigger at the exact configured threshold:
  8 failed login attempts against one email returned 401, the 9th
  returned 429.
- All test data cleaned up afterward; dev database is empty.

**Known limitations:** see `docs/SECURITY.md` "Known gaps" — no 2FA, no
email verification/password reset flow (Mailboxlayer deferred to Phase 5
on purpose, to avoid a one-off external call ahead of the provider
abstraction layer), no CSRF token (relying on SameSite=Lax + JSON-only
endpoints), passport-number encryption-at-rest outstanding.

**Next phase:** Phase 5 — External API Integration Layer.

---

## Phase 5 — External API Integration Layer

**Status:** Complete

**Implemented:**

- `src/integrations/types.ts` — `ExternalProvider` marker interface +
  shared `fetchJson` helper (one HTTP attempt, normalizes failures to
  `ProviderError`; retry/backoff is explicitly Phase 6's job, not built
  here).
- Eight provider domains, each with a real adapter + documented mock +
  factory: Aviation (Aviationstack), Weather (Weatherstack), Currency
  (**two** independent real adapters — Fixer and ExchangeRate — behind
  one interface, proving the abstraction is genuine), Search (Zenserp),
  DocumentStorage (Filestack), Geolocation (IPstack), PhoneValidation
  (Numverify), EmailValidation (Mailboxlayer).
- `docs/INTEGRATIONS.md` — full writeup, including an honest
  per-provider table of verification confidence (see below) and the two
  deliberately-excluded providers (Screenshotlayer: no feature needs it
  yet; Marketstack: no role in a travel platform).
- **Closed the loop from Phase 4**: `register/route.ts` now calls
  Mailboxlayer for email deliverability, failing open on any provider
  error — exactly what `docs/SECURITY.md`'s known-gaps section said would
  happen "once Phase 5 lands."

**Verification methodology:** this sandbox's network egress doesn't reach
any vendor domain (same constraint as Postgres/Redis tooling, Phase 3),
so no adapter could be smoke-tested live. Instead:

- **Aviationstack, Weatherstack, Fixer/ExchangeRate** response shapes
  were verified against multiple independent, dated public sources via
  web search this session — not built from memory alone. This surfaced
  two genuine, non-obvious findings: Weatherstack returns HTTP 200 even
  for API-level errors (error only visible in the body shape — now has a
  dedicated test), and Fixer has migrated to APILayer's unified
  `api.apilayer.com/<product>` gateway with an `apikey` header, distinct
  from the legacy `data.fixer.io?access_key=` convention most tutorials
  still show.
- **Zenserp, Filestack, IPstack, Numverify, Mailboxlayer** are built from
  training knowledge, explicitly flagged in code comments and
  `docs/INTEGRATIONS.md` as not verified this session — re-check before
  real use, Filestack especially (its actual upload flow has more moving
  parts than this simple version covers).
- Every adapter tested by stubbing `fetch` with a realistic fixture and
  asserting correct normalization, vendor error-shape handling, and
  rejection of malformed responses — real parsing-logic tests, without
  needing a live network hop.

**Tests — all executed for real:**

- `pnpm typecheck` → 0 errors
- `pnpm lint` → 0 errors, 0 warnings
- `pnpm test` → 57/57 passing (26 new: 6 aviation, 5 weather, 7 currency
  covering both vendors via `describe.each`, 8 supporting providers)
- `pnpm build` → succeeded
- **Live verification of the fail-open Mailboxlayer path**: with a real
  (but sandbox-unreachable) `MAILBOXLAYER_API_KEY` configured, a real
  registration request against the booted server still succeeded
  end-to-end — the real adapter's genuinely-failing network call was
  caught and swallowed exactly as designed, not just simulated in a unit
  test. Test data cleaned up afterward.

**Known limitations:** see `docs/INTEGRATIONS.md`'s verification-
confidence table — five of eight providers are unverified against live
docs. `getCurrencyProvider()`'s selection order (Fixer, then ExchangeRate,
then mock) reflects credential availability only, not a resilience
fallback on call failure — that composition is explicitly Phase 6's job.

**Next phase:** Phase 6 — API Resilience.

---

## Phase 6 — API Resilience

**Status:** Complete

**Implemented:**

- `infrastructure/circuit-breaker.ts` — in-memory three-state machine
  (CLOSED/OPEN/HALF_OPEN) per provider, deliberately not Redis-backed
  (single-instance app; no evidence a multi-instance deployment is
  needed yet).
- `infrastructure/resilience.ts` — the orchestrator implementing
  `docs/ARCHITECTURE.md`'s exact flow: cache check → provider call with
  retry+backoff (only on retryable errors — 5xx/429/network, never a
  4xx like a bad key) → fallback provider → degraded mode via stale
  cache → clear `ProviderError` if nothing is left. Every result reports
  its source (`cache`/`live`/`fallback`/`degraded-cache`) and staleness —
  this is where Phase 17's confidence scoring will get its provenance.
- `integrations/types.ts`'s `fetchJson` gained a timeout (`AbortController`,
  10s default) — a per-request concern distinct from the multi-attempt
  orchestration above it.
- Wired transparently into Aviation, Weather, and Currency's factory
  functions — callers still just call `.getFlightStatus()` etc.
  normally; resilience is invisible to them. Mock adapters stay
  unwrapped (no real failure mode to be resilient against).
- **Currency's real fallback, deliberately deferred from Phase 5, now
  exists**: when both `FIXER_API_KEY` and `EXCHANGERATE_API_KEY` are
  configured, a genuine primary→fallback composition runs.
- `modules/observability/api-health-repository.ts` — every provider
  attempt now updates Phase 3's previously-unused `api_health` table
  (DEGRADED at 1–2 consecutive failures, DOWN at 3+, OPERATIONAL on
  success), giving Phase 23's observability panel real data instead of
  invented metrics.

**Two real bugs found by testing against real infrastructure, not by inspection:**

1. `api_health`'s upsert query wrote unquoted enum string literals inside
   a `CASE` + `ON CONFLICT` combination — Postgres's type inference
   failed (`column "status" is of type "ApiHealthStatus" but expression
is of type text`), a runtime SQL error TypeScript could never catch.
   Found via a dedicated test against real Postgres, fixed with explicit
   `::"ApiHealthStatus"` casts. Noted in `AGENTS.md` since every future
   phase writing to an enum column will face the same risk.
2. During manual verification of the live currency fallback, a call hung
   far past its expected duration. Root cause: Redis was unreachable
   (background services don't persist between tool invocations in this
   sandbox), and `ioredis`'s default reconnect behavior doesn't fail fast
   against a genuinely unreachable server — which would have quietly
   undermined `resilience.ts`'s "cache failures are non-fatal" design
   intent in any environment, not just this sandbox. Fixed with an
   explicit `connectTimeout` + capped `retryStrategy` on the shared Redis
   client, verified with a dedicated test against a deliberately
   unreachable address (600ms now, was 30+ seconds).

**Tests — all executed for real:**

- `pnpm typecheck` → 0 errors
- `pnpm lint` → 0 errors, 0 warnings
- `pnpm test` → 81/81 passing (24 new: 8 circuit breaker covering the
  full state machine including recovery and re-opening, 9 resilience
  orchestrator covering cache/retry/non-retryable/fallback/degraded/
  full-failure/circuit-integration, 5 api_health against real Postgres,
  1 Redis connection-bounds against a genuinely unreachable address,
  plus 1 new end-to-end fallback-composition test in currency's suite)
- `pnpm build` → succeeded
- **Live verification, not just mocked**: with real (sandbox-unreachable)
  Fixer and ExchangeRate credentials configured, a real call through the
  actual factory-produced provider correctly attempted Fixer, correctly
  recognized the 403 as non-retryable (skipped wasting time on retries),
  fell over to ExchangeRate, correctly did the same, and threw a clear
  structured error — the entire chain completing in 170ms once Redis was
  confirmed running.

**Known limitations:** circuit breaker state is in-memory only (resets on
process restart; acceptable for a single instance, would need Redis for
a multi-instance deployment). `api_health` writes are fire-and-forget —
an observability write failure never affects the actual response, by
design, but also means it's possible (rare) for health data to lag
reality by one request.

**Next phase:** Phase 7 — Trip Digital Twin.

---

## Phase 7 — Trip Digital Twin

**Status:** Complete

**Implemented:**

- Six repositories (`trip`, `traveler`, `destination`, `flight`,
  `document`, `trip-event`, plus `weather-snapshot` and
  `currency-snapshot`) — raw `pg`, same interim approach as auth/
  api-health given Prisma Client can't be generated in this sandbox.
  Enum columns cast explicitly this time (`'PLANNING'::"TripStatus"`)
  from the start, applying the Phase 6 lesson rather than rediscovering it.
- `modules/trip/trip-service.ts` — the actual domain service, covering
  every operation the brief lists: creating trip, updating trip, adding
  destinations, adding flights, attaching documents, changing trip
  state, recording snapshots, calculating operational state.
- **Closes the resource-ownership authorization gap deliberately left
  open in Phase 4**: `requireOwnedTrip()` throws the _identical_
  `NotFoundError` whether a trip doesn't exist or belongs to someone
  else — verified live, not just reasoned about (see below).
- Immutable event history: every mutating operation writes a
  `trip_events` row via `recordTripEvent()`. Direct user actions get a
  fresh-UUID dedupe key (no natural retry-duplication risk, unlike the
  snapshot-comparison events Phase 9's idempotency design already covers).
- `calculateOperationalState()` — deliberately simple, deterministic,
  real-data-only (INCOMPLETE/ON_TRACK/ATTENTION_NEEDED/DISRUPTED based on
  the latest flight snapshot per flight). Explicitly the precursor to
  Phase 16's weighted risk score, not a preview of it.
- `getTripDigitalTwin()` — the full assembled view. Documents/risk/
  recommendations are genuinely empty right now (no write path exists
  until Phase 14/16/17), not stubbed with fake data.
- 8 API routes: `POST/GET /api/trips`, `GET/PATCH /api/trips/[id]`, plus
  `travelers`, `destinations`, `flights`, `status`, `events`,
  `operational-state` sub-routes.
- Extended `withApiHandler` again — this time for Next.js's route
  `context` (dynamic segment params), needed the moment a route had a
  `[id]` segment. Verified against Next's own route-type validator (not
  just `tsc`) for both dynamic and static routes together.

**Tests — all executed for real, against real Postgres:**

- `pnpm typecheck` → 0 errors
- `pnpm lint` → 0 errors, 0 warnings
- `pnpm test` → 97/97 passing (16 new: full CRUD, both authorization
  cases — genuine not-found and cross-user access both resolving to the
  same `NotFoundError` — and all four operational-state branches,
  including one proving the calculation reads the _latest_ snapshot, not
  just any row, by inserting an old good one and a new bad one)
- `pnpm build` → succeeded, all 8 new routes registered correctly
- **Full live 11-step curl flow**: two real users registered, one
  creates a trip → operational state genuinely `INCOMPLETE` → destination
  and flight added → state genuinely flips to `ON_TRACK` → the second
  user's attempts to view or modify the first user's trip both return
  **404, not 403** → owner's full digital twin and event history both
  correct, event log in the right order. Test data and processes cleaned
  up afterward.

**Known limitations:** no trip-status transition validation yet (e.g.
nothing stops `CANCELLED` → `ACTIVE`) — noted as a real gap in
`trip-service.ts` rather than silently assumed correct.

**Next phase:** Phase 8 — AI Tool Layer.

---

## Phase 8 — AI Tool Layer

**Status:** Complete

**Implemented:**

- `src/ai/tools/types.ts` — the `ToolDefinition`/`ToolContext`/`ToolResult`
  contracts. `ToolContext.userId` is injected from the authenticated
  session; it is never part of a tool's LLM-facing input schema — the
  actual mechanism that keeps a prompt injection or model confusion from
  ever reaching another user's data, regardless of what `tripId` a tool
  call specifies.
- All 10 tools named in the brief: `get_trip`, `get_trip_documents`,
  `get_flight_status`, `get_weather`, `get_currency_rate`,
  `search_destination`, `search_trip_knowledge`, `calculate_budget`,
  `create_recommendation`, `create_alert`. Every one: typed input (Zod),
  validated, trip-ownership-authorized, structured output, logged.
- `src/ai/tools/registry.ts` — `TOOL_REGISTRY` is the actual enforcement
  point for "the AI layer should interact only with approved tools": no
  code path can execute a tool by name unless it's a key in that map.
  `callTool()` is the single execution path: registry check → schema
  validation → execute → structured `ToolResult` either way, never a
  thrown exception.
- Two new repositories the write-tools needed:
  `recommendation-repository.ts` (Phase 3's table, no write path until
  now) and `notification-repository.ts` (same).
- `docs/AI_ARCHITECTURE.md` — the security model, the full execution
  path, and an honest per-tool scope table (e.g. `calculate_budget` is a
  currency conversion, not a full trip cost estimate; `search_trip_knowledge`
  honestly reports "not yet processed" rather than fabricating a match,
  since Phase 15's embedding pipeline doesn't exist yet).

**A real TypeScript variance issue, resolved properly, not worked around:**
`ToolDefinition<TInput, TOutput>`'s `execute` method makes it
contravariant in `TInput` — a heterogeneous registry needs the opposite
variance from what a naive `Record<string, ToolDefinition<unknown, unknown>>`
provides. Fixed by defaulting `TInput`/`TOutput` to `any` at the storage
boundary (the standard pattern for this; real safety comes from each
tool's own `inputSchema.safeParse()` at execution time, not the stored
type) plus an explicit type annotation at the registry lookup site to
avoid TypeScript computing an impossible intersection type across all 10
tools' differing parameter shapes. Both `any` usages are narrowly scoped
and explained inline, with a targeted (not blanket) eslint-disable.

**A real test-hygiene bug found and fixed:** the Phase 6 currency
fallback end-to-end test only cleaned up its Redis cache key in
`afterEach`. A stale cached rate from an earlier successful run was
found still present (confirmed directly via `redis-cli get`/`ttl` before
fixing) and had been silently letting that test pass via a cache hit
without genuinely exercising the fallback path. Fixed by adding
`beforeEach` cleanup too, making the test self-healing regardless of
what happened in any previous run — `resilience.test.ts` already had
this pattern from the start; this test just hadn't been given the same
discipline when it was added later.

**Tests — all executed for real, against real Postgres:**

- `pnpm typecheck` → 0 errors
- `pnpm lint` → 0 errors, 0 warnings
- `pnpm test` → 111/111 passing (14 new tool-registry tests: the
  approved-tools-only boundary, structured-error-not-exception input
  validation, authorization enforced against the injected `userId`
  across two real users for both a read tool and the write tools —
  including confirming `create_alert` cannot be used to notify anyone
  but the trip's real owner — and successful calls with genuine side
  effects checked directly against Postgres)
- `pnpm build` → succeeded (no new routes yet — tools are consumed by an
  orchestrator, Phase 9, not exposed directly, which is correct)

**Known limitations:** no per-run execution limits yet (max tool calls,
wall-clock budget, no agent-to-agent recursion) — deliberately Phase 9's
job, not this layer's; see `docs/AI_ARCHITECTURE.md`.

**Next phase:** Phase 9 — AI Orchestrator.

---

## Phase 9 — AI Orchestrator

**Status:** Complete

**Implemented:**

- `src/ai/agents/types.ts` — `AgentDefinition` (role, allowed tools
  subset, structured output schema) and `defineAgent()`. The 7
  specialized agents the brief names are Phases 10–13/16–17/20's job to
  define using this framework; this phase built the framework and the
  loop that runs any agent defined with it.
- `src/ai/orchestrator.ts`'s `runAgent()` — a real Claude tool-use loop
  against the actual `@anthropic-ai/sdk`. Converts each allowed tool's
  Zod schema to a JSON Schema via Zod 4's native `z.toJSONSchema()`, adds
  a `provide_final_answer` pseudo-tool matching the agent's output
  schema, and loops until the model calls it (validated), or a hard
  limit trips.
- Hard limits, all three actually enforced and tested: max tool calls
  (default 8, matching Phase 1's `docs/ARCHITECTURE.md` Section 10 —
  honored, not reinvented), wall-clock timeout (default 30s), and a new
  cumulative token budget (default 50,000) for "token usage where
  applicable." All three injectable per call so tests exercise the
  timeout/budget paths in milliseconds rather than waiting out the real
  default.
- **No agent-to-agent recursion is possible by construction**: a
  tool-use block can only trigger `callTool()` (Phase 8), which can only
  execute a registered tool, never another agent — there's no code path
  for it, not just a documented rule against it.
- Invalid structured output gets one corrective retry (fed back as a
  validation-error tool result) within the existing tool-call budget,
  rather than failing the whole run on one malformed attempt.
- Added `getToolDefinition()` to the Phase 8 registry — a proper lookup
  the orchestrator needed to build per-agent tool schemas.

**Two real bugs found and fixed by testing, not by inspection:**

1. Two generic Zod-4 type-inference gaps (`defineAgent`, mirroring the
   identical `defineTool` issue from Phase 8) — same already-justified
   fix pattern (a narrow, explained type assertion) applied rather than
   re-derived, since it's the same root cause.
2. **The actual orchestrator test suite initially failed 8 of 9 tests**
   with a misleading `API_ERROR` on every one. Root cause: the Anthropic
   SDK mock used `vi.fn().mockImplementation(() => ({...}))` — an arrow
   function — for a class the code calls with `new Anthropic(...)`.
   Arrow functions have no `[[Construct]]` behavior in JavaScript and
   cannot be invoked with `new`, so every single call was silently
   throwing "is not a constructor," caught by the orchestrator's own
   error handling and reported as `API_ERROR` — which is _also_ the
   correct expected outcome for one specific test, which is exactly why
   it was the only one passing and why the pattern looked confusing
   rather than uniform. Diagnosed with an isolated minimal reproduction
   file (not by guessing at fixes) before fixing with a real `function`.

**Tests — all executed for real, mocking only the Anthropic API boundary:**

- `pnpm typecheck` → 0 errors
- `pnpm lint` → 0 errors, 0 warnings
- `pnpm test` → 120/120 passing (9 new orchestrator tests: success with
  no tools needed, success with a real tool call whose real result is
  proven to reach the model's next turn, a _genuine_ tool failure —
  nonexistent trip ID — proven to reach the model as a real `NOT_FOUND`
  error rather than crashing the run, structured-output validation
  retry, all three hard limits tripped with real (small, injected)
  timing, and both `API_ERROR` and `MODEL_STOPPED_WITHOUT_ANSWER`
  handled without throwing)
- `pnpm build` → succeeded. No new routes — an orchestrator without an
  agent to call is infrastructure, not yet a feature; that wiring
  belongs to whichever phase first needs to expose it (likely Phase 21's
  command bar or the first specialized agent, whichever lands first).

**Known limitations:** no real `ANTHROPIC_API_KEY` available in this
sandbox — unlike the travel provider domains, `api.anthropic.com` is
actually reachable here, so the gap is a credential, not a network
restriction. Every test mocks the Anthropic API boundary only; the tool
registry, authorization, and Postgres underneath are genuinely real.
Live end-to-end verification needs a real key.

**Next phase:** Phase 10 — Flight Agent.

---

## Phase 10 — Flight Agent

**Status:** Complete

**Implemented:**

- A key scope decision, made explicit: `src/ai/agents/flight-agent.ts`
  is a plain deterministic TypeScript service, **not** an
  `AgentDefinition` run through Phase 9's orchestrator. Every
  responsibility the brief lists (retrieve, normalize, compare, emit) is
  a data operation, not a reasoning task — routing it through an LLM
  would be exactly the "use AI where deterministic logic is better"
  mistake Section 37 warns against.
- `mapProviderStatusToFlightStatus()` — the explicit, documented
  reconciliation between Aviationstack's normalized vocabulary
  (`scheduled/active/landed/cancelled/incident/diverted/unknown`) and
  this domain's fixed `FlightStatus` enum, which don't line up
  one-to-one. DELAYED is derived from delay minutes (15-minute
  threshold), not the raw status string, since a flight can be
  `"active"` and still meaningfully delayed.
- Added the missing write side to `flight-repository.ts`
  (`insertFlightStatusSnapshot`) — Phase 7 only built the read side,
  deferring the insert to this phase as planned.
- `processFlightStatusUpdate()` — the pure domain operation (no
  `userId`), for Phase 19's Trip Watch to call directly later.
  `runFlightAgentForUser()` wraps it with Phase 7's ownership check for
  the user-triggered case that exists now.
- `POST /api/trips/[id]/flights/[flightId]/check-status` — a route
  exposing manual triggering, consistent with Phase 7's pattern of
  pairing domain services with a route rather than leaving them
  unreachable until a later phase needs them.
- Never invents flight data: a provider miss records `UNKNOWN` (checked,
  found nothing — not the same as never checked); a provider failure
  throws rather than fabricating a plausible status.
- Idempotent event emission: only a genuine status change emits
  `FLIGHT_UPDATED`, with a dedupe key tied to the exact snapshot.

**A real test-isolation bug found and fixed, same class as Phase 8's:**
the Aviation provider's resilience cache (Phase 6) keys by flight
number, not by test case. Multiple tests in this file reused "ET602" —
one test's second check was genuinely served the first check's cached
response and never reached its own new mock at all, failing the
assertion outright. Worse, other tests in the same file were passing
"by coincidence" (both scenarios happened to expect the same SCHEDULED
result) without actually proving isolation. Fixed with `beforeEach`
cache clearing for every flight number used in the file, not just a
one-off patch on the test that visibly failed.

**Tests — all executed for real, against real Postgres:**

- `pnpm typecheck` → 0 errors
- `pnpm lint` → 0 errors, 0 warnings
- `pnpm test` → 131/131 passing (11 new: the status mapping function
  across every branch including the "active-but-delayed" case, a
  first-check baseline, confirmation that an unchanged follow-up check
  emits no duplicate event, a genuine status change to DELAYED with the
  correct dedupe key verified directly against the database, the
  never-invent-data behavior on a provider miss, and authorization)
- `pnpm build` → succeeded, new route registered
- **Live end-to-end verification against the real, genuinely-blocked
  Aviationstack API**: registered a real user, created a trip, added a
  flight, triggered a real status check. The real network call returned
  a genuine 403, correctly classified as non-retryable (`retryable:
false` in the actual log output), correctly had no cache to degrade to
  (first-ever check), and surfaced as a clean structured `502
PROVIDER_ERROR` — never invented data, never crashed. Test data and
  the server process cleaned up afterward.

**Next phase:** Phase 11 — Weather Agent.

---

## Phase 11 — Weather Agent

**Status:** Complete

**Implemented:**

- `src/ai/agents/weather-agent.ts` — same deterministic family as the
  Flight Agent, for the same reason, stated even more explicitly by this
  phase: "Do not allow the LLM to invent numerical weather values."
  There's no LLM in this file to invent anything.
- `detectSignificantWeatherChange()` — a documented, deliberately
  **different** first-reading policy from the Flight Agent's: an
  unremarkable baseline reading ("22°C, sunny") emits no event, since
  establishing it isn't itself news the way a flight's first confirmed
  status is. A **severe** first reading (checked against a documented,
  explicitly non-exhaustive keyword list) does emit one, regardless of
  whether a previous snapshot exists. Genuine deltas from a real
  previous reading — temperature (8°C), wind speed (20 kph),
  precipitation starting/stopping — are checked the same way every time.
  This asymmetry with the Flight Agent is a considered decision, not an
  inconsistency: a flight's status genuinely has no "unremarkable
  default" (UNKNOWN itself is informative), while ordinary weather does.
- Two-layer design matching Phase 10: `processWeatherUpdate()` (pure,
  for Phase 19's Trip Watch) and `runWeatherAgentForUser()` (Phase 7
  ownership check, for the manual-trigger case that exists now).
- `POST /api/trips/[id]/destinations/[destinationId]/check-weather`.
- Never invents weather data: unlike Aviation (which can return "no
  matching flight" as a distinct non-error case), the Weather provider
  either succeeds or throws — a failure propagates as a thrown error;
  nothing is recorded in its place.

**Tests — all executed for real, against real Postgres:**

- `pnpm typecheck` → 0 errors
- `pnpm lint` → 0 errors, 0 warnings
- `pnpm test` → 144/144 passing (13 new: every branch of significance
  detection including the deliberate first-reading policy difference
  from Phase 10, a baseline-with-no-event pipeline run, a severe-first-
  reading pipeline run with the event's dedupe key verified against the
  database, no-duplicate-event on an insignificant follow-up check, a
  genuine provider failure confirmed to leave zero rows written rather
  than fabricating data, and authorization). One transient
  `ECONNREFUSED` mid-suite-run from this sandbox's established
  service-persistence pattern (not a code issue) — resolved by
  restarting Postgres and re-running; all 144 passed clean immediately after.
- `pnpm build` → succeeded, new route registered
- **Live end-to-end verification against the real, genuinely-blocked
  Weatherstack API**: registered a user, created a trip, added a
  destination, triggered a real weather check. The real network call
  returned a genuine 403, correctly classified as non-retryable, had no
  cache to degrade to, and surfaced as a clean structured `502
PROVIDER_ERROR`. Test data and the server process cleaned up afterward.

**Next phase:** Phase 12 — Currency Agent.

---

## Phase 12 — Currency Agent

**Status:** Complete

**Implemented:**

- A scope decision made explicit up front: the brief's own text for this
  phase (retrieval, normalization, conversion, timestamped snapshots,
  caching) omits "detect significant changes"/"compare against previous
  snapshot," unlike Phases 10/11. Respected as a deliberate difference,
  not an oversight — documented in `docs/AI_ARCHITECTURE.md` rather than
  silently adding or silently omitting without comment.
- `src/ai/agents/currency-agent.ts` — since retrieval, normalization,
  caching, and the resilient dual-vendor fallback all already existed
  end-to-end from Phase 5/6, what this phase actually added: a single
  cohesive call (`getExchangeRateSnapshot`/`runCurrencyAgentForUser`)
  that fetches the rate **and** records the timestamped snapshot
  together, where previously those were two separate, unconnected calls.
- `convertCurrencyAmount()` — extracted as a shared, tested utility,
  replacing an inline duplicate multiplication in the `calculate_budget`
  tool (Phase 8) so the rounding logic can't drift between the two.
- **A real bug caught and fixed before it ever ran**: the first draft of
  the pure domain function called trip-service's authorization-wrapped
  `recordCurrencySnapshot` with a placeholder `"system"` userId — which
  would always throw, since no trip is ever owned by a user literally
  named that. Caught by re-reading the code against the Flight/Weather
  agents' established pattern (their pure functions call the repository
  layer directly, bypassing the authorization wrapper entirely) before
  writing a single test, not discovered via a failing test afterward.
  Fixed to match that pattern, and a second pass eliminated duplicated
  fetch-and-record logic between the pure and user-facing functions —
  the user-facing one now just checks ownership, then delegates.
- Every snapshot is recorded with no significance gate, consistent with
  this phase's lighter scope — two identical consecutive checks produce
  two rows and two events, not deduplicated the way Flight/Weather are.
- `POST /api/trips/[id]/currency-check`.

**Tests — all executed for real, against real Postgres:**

- `pnpm typecheck` → 0 errors
- `pnpm lint` → 0 errors, 0 warnings
- `pnpm test` → 152/152 passing (8 new: the conversion utility including
  correct rounding vs. truncation, the cohesive fetch-and-record pipeline
  with and without an amount, confirmation that every check is recorded
  without a dedup gate, and authorization)
- `pnpm build` → succeeded, new route registered
- **The most comprehensive live verification of the three data agents so
  far**: with both real Fixer and ExchangeRate credentials configured, a
  real end-to-end run exercised the entire dual-vendor fallback chain —
  Fixer attempted and correctly failed fast on a non-retryable 403,
  immediate failover to ExchangeRate, which also correctly failed fast
  the same way, both outcomes visible in the actual structured logs,
  ending in one clean `PROVIDER_ERROR` instead of two separate unhandled
  failures. This is the Phase 6 resilience composition — deferred all
  the way back from Phase 5 — proven working end-to-end with two real,
  independent, genuinely-blocked vendors. Test data and the server
  process cleaned up afterward.

**Next phase:** Phase 13 — Research Agent.

---

## Phase 13 — Research Agent

**Status:** Complete

**Implemented:**

- `src/ai/agents/research-agent.ts` — the first specialized agent that
  genuinely belongs in Phase 9's LLM orchestrator rather than a plain
  deterministic service. "Summarize only retrieved information" is a
  synthesis task with no formula behind it, unlike Phases 10–12.
- The system prompt is the real enforcement mechanism for "never present
  search-generated information as verified fact without evidence" —
  there's no code-level way to verify an LLM's answer only used
  retrieved facts. What _is_ code-enforced: `hasEvidence` is a required
  boolean, and a defense-in-depth check rejects any answer claiming
  `hasEvidence: true` while citing zero sources, rather than passing
  along an internally inconsistent answer just because it matched the
  schema's types.
- Deliberate double authorization: `search_destination` already checks
  trip ownership internally (Phase 8), but `runResearchAgentForUser`
  checks again up front — without it, a rejection would only surface as
  a confusing tool-result buried inside the orchestration loop instead
  of failing cleanly before an LLM call is even made. Verified directly:
  a non-owner's request is rejected with the mock Anthropic client never
  called at all.
- Trip destinations are pre-fetched into the question context rather
  than requiring a wasted `get_trip` tool call for the common case;
  `get_trip` stays available if more detail is needed.
- `POST /api/trips/[id]/research`.

**Tests — all executed for real, mocking only the Anthropic API boundary:**

- `pnpm typecheck` → 0 errors
- `pnpm lint` → 0 errors, 0 warnings
- `pnpm test` → 159/159 passing (7 new: authorization enforced before
  any LLM call, question validation, real trip context proven present
  in the actual message sent to the model, a full search-then-answer
  pipeline with real source attribution, an honest "no evidence found"
  answer accepted, the inconsistent-evidence-claim rejection, and
  orchestrator failure propagation). Applied the Phase 9 mock lesson
  (a real `function`, not an arrow function, for the Anthropic SDK mock)
  from the start — all tests passed on the first run, no repeat of that
  debugging cycle.
- `pnpm build` → succeeded, new route registered
- **Live verification went further than Phase 9's could**: with no real
  `ANTHROPIC_API_KEY` configured at all, the actual `@anthropic-ai/sdk`
  client throws a specific, genuine error — "Could not resolve
  authentication method" — before attempting any network call. Confirmed
  that error propagates correctly through every layer: the
  orchestrator's own handling (`API_ERROR`), `runResearchAgentForUser`'s
  wrapping (`ProviderError`), out to the client as a clean structured
  `502` — full stack trace confined to the server log only. The Phase 2
  "never leak internals" principle holding through the deepest pipeline
  built so far. Test data and the server process cleaned up afterward.

**Next phase:** Phase 14 — Document Intelligence.

---

## Phase 14 — Document Intelligence

**Status:** Complete (backend pipeline)

**Implemented:**

- **Real upload + extraction pipeline** (`src/modules/trip/document-service.ts`):
  validate → store → persist (UPLOADED) → extract → READY/FAILED. This
  is Section 13's flow with one honest deviation: extraction runs inline
  in the request instead of on a BullMQ worker, because the queue/worker
  infrastructure is explicitly Phase 18's deliverable. The processing
  function is isolated so moving it behind a worker later is a wiring
  change, not a rewrite.
- **Content-based validation stays authoritative**: the service reuses
  `validateFileUpload` (Phase 4) — magic-byte sniffing via `file-type`,
  10MB cap, declared-vs-actual MIME mismatch rejection — before anything
  reaches storage.
- **Real PDF text extraction** (`document-extraction.ts`) via `unpdf`, a
  maintained pdf.js wrapper with zero runtime dependencies. Tests run
  the real parser against a programmatically built, byte-valid PDF
  fixture — the parser is never mocked.
- **Deterministic, evidence-backed structured metadata**: flight numbers
  (deny-listing currency codes so `USD 100` isn't a "flight"), ISO and
  written dates, and booking references (6-char alphanumeric requiring a
  letter AND a digit, only near booking-ish keywords). Each fact carries
  its surrounding text as evidence. No LLM, nothing guessed.
- **Honest failure semantics**, per Section 13's rule that READY is
  never claimed unless extraction actually happened:
  - Images (JPEG/PNG) are stored but FAILED with an explicit reason —
    OCR is not implemented in this build.
  - A PDF with no text layer is FAILED ("No extractable text found"),
    not READY-with-empty-text.
  - A corrupt PDF is FAILED with a generic client-safe reason; full
    parser detail goes to the server log only.
  - A storage-provider failure propagates and creates no document row;
    ownership is checked before any provider call.
- **Real status transitions**: UPLOADED → PROCESSING → READY/FAILED,
  with PROCESSING written before extraction starts.
- **Events**: DOCUMENT_UPLOADED (existing) plus DOCUMENT_PROCESSED /
  DOCUMENT_PROCESSING_FAILED carrying page count or reason.
- **API**: `POST /api/trips/[id]/documents` (multipart `file` field) and
  `GET /api/trips/[id]/documents`, both through `withApiHandler`.
- **Frontend surface on the trip page** (the phase's second half): a
  `DocumentUploadForm` client island posts multipart FormData (deliberately
  NOT through the JSON `postJson` helper — that sets a Content-Type that
  would strip the multipart boundary) and reports the real outcome back:
  page/character counts and extracted facts for READY, the stored failure
  reason for FAILED. The server-rendered Documents card shows each
  document's status badge (`documentStatusTone`), failure reason, and the
  extracted flight numbers / booking references / dates, read defensively
  from the JSONB metadata column since its shape genuinely varies.
- **Fixed a pre-existing Phase 21 defect found by live verification**:
  `components/ui.tsx` is a `"use client"` module, and the three server
  pages called `tripStatusTone()` imported from it. Every export of a
  client module is a client reference, so calling one on the server
  throws "Attempted to call tripStatusTone() from the server" — meaning
  `/trips`, `/trips/[id]`, and `/trips/analytics` had been returning
  **500 since Phase 21**. Typecheck, lint, tests, and the production build
  all passed regardless: this failure only appears at request time. The
  pure helpers now live in `src/components/tone.ts` (no directive), and
  the fix was confirmed against the running app — all four trip routes
  return 200. Worth remembering: nothing in this repo's static checks
  exercises a server component's render path.
- **Schema**: `trip_documents.extracted_text` added — separate from
  `extracted_metadata` because it is a document body, not metadata, and
  the summary queries deliberately don't select it.

**Files changed:**

- `src/modules/trip/document-service.ts` (new)
- `src/modules/trip/document-extraction.ts` (new)
- `src/modules/trip/document-fixtures.ts` (new — test-only)
- `src/modules/trip/document-repository.ts` (transitions + metadata/
  failure fields, explicit `::"DocumentStatus"` casts)
- `src/app/api/trips/[id]/documents/route.ts` (new)
- `src/modules/trip/document-service.test.ts`,
  `src/modules/trip/document-extraction.test.ts` (new)
- `src/components/tone.ts` (new), `src/components/ui.tsx`,
  `src/app/trips/**` (upload island + documents card)
- `prisma/schema.prisma`, `package.json`, `pnpm-lock.yaml`, docs

**Tests:**

- `pnpm typecheck` → 0 errors
- `pnpm lint` → 0 errors, 0 warnings
- `pnpm test` → 176/176 passing (22 files; +17 new: 8 extraction unit
  tests against a real PDF, 9 service integration tests against real
  Postgres with the storage boundary mocked)
- `pnpm build` → succeeded. This surfaced a pre-existing Phase 21 issue
  the earlier verification pass missed: `/login` and `/register` called
  `useSearchParams()` without a Suspense boundary, which failed static
  prerendering. Both were wrapped in Suspense (with the same shell as
  their fallback) and the build then completed.

**Known limitations:**

- Processing is inline, not queued (Phase 18 owns workers/queues).
- OCR is not implemented; the pipeline reports that explicitly rather
  than pretending.
- The Filestack adapter is still unverified against the live API —
  sandbox egress doesn't reach filestack.com. Real uploads use the
  documented mock adapter when `FILESTACK_API_KEY` is unset.
- pgvector is unavailable in this sandbox's Postgres 14, but Phase 14
  writes no chunks (that's Phase 15).

**Next phase:** Phase 15 — RAG System (chunk and embed
`trip_documents.extracted_text`, retrieval, and the pgvector
`document_chunks` writes this schema has been holding open).

---

## Phase 15 — RAG System

**Status:** Complete

**Implemented:**

- **Real vector search, not a simulation.** pgvector was absent from this
  environment (not packaged for the local Postgres 14), so the extension
  was built from source, installed, and enabled on both local databases.
  `document_chunks.embedding` is now a genuine `vector(1024)` column with
  an HNSW cosine index, and ranking is Postgres's own `<=>` operator.
  Found the old sandbox workaround (a `text` column standing in for the
  vector) by checking `pg_extension` before designing anything.
- **Embedding provider decided and wired** (`src/integrations/embeddings/provider.ts`):
  Voyage AI's `voyage-3`, which is what the column is now sized to. It
  sends `input_type: document|query`, batches at 64 inputs, and — the
  detail that matters most for a retrieval system — rejects a response
  whose vector count or dimension doesn't match the request rather than
  letting vectors misalign onto the wrong chunks.
- **A documented local fallback that is real math, not a fake response.**
  With no key configured, a feature-hashing embedder computes actual
  normalized 1024-dimension vectors, so chunking, storage, ranking, and
  the UI all work end to end offline. It is honestly weaker: similarity
  is lexical, not semantic, so `semantic: false` is carried on every
  result and the UI says so in plain language. The project's
  "documented mock adapter, never simulated success" rule is satisfied
  without pretending a hash is an embedding model.
- **Deterministic chunking** (`src/modules/trip/document-chunking.ts`):
  paragraph → sentence → word boundaries in that order, target 1000
  chars, hard cap 1400, 150-char overlap so a sentence straddling a
  boundary is still retrievable. Token counts are documented estimates
  (~4 chars/token) and never influence a boundary or a ranking.
- **RAG service** (`src/modules/trip/rag-service.ts`): index a document
  (chunks → embeds → replaces prior chunks in one transaction, so
  re-indexing is idempotent rather than duplicating rows) and search a
  trip's chunks. The trip scope is applied in the same SQL statement as
  the ranking, not as a separate authorization step a later refactor
  could reorder or drop.
- **Honest retrieval outcomes**: chunks come back with the similarity
  that ranked them, `noEvidence: true` when nothing clears the floor,
  and the provider's name and semantic flag on every response.
- **Wiring**: successful extraction now indexes automatically — a
  _failure_ there is logged and leaves the document honestly READY
  rather than rewriting it as FAILED, with
  `POST /api/trips/[id]/documents/[documentId]/index` as the recovery
  path. `POST /api/trips/[id]/documents/search` serves retrieval, and the
  trip page gained a search card showing ranked chunks, similarity
  percentages, and the live indexed-chunk count.
- **Schema**: `document_chunks.embedding` is `vector(1024)` (was a
  provisional 1536 placeholder whose own comment said to revisit it in
  Phase 15), plus an HNSW cosine index created via raw SQL.

**Files changed:**

- `src/integrations/embeddings/provider.ts` (new)
- `src/modules/trip/document-chunking.ts`,
  `src/modules/trip/document-chunk-repository.ts`,
  `src/modules/trip/rag-service.ts` (new)
- `src/modules/trip/document-repository.ts` (text-loading read path),
  `src/modules/trip/document-service.ts` (auto-index after extraction)
- `src/app/api/trips/[id]/documents/search/route.ts`,
  `src/app/api/trips/[id]/documents/[documentId]/index/route.ts` (new)
- `src/app/trips/[id]/page.tsx`, `src/app/trips/[id]/trip-actions.tsx`
  (search surface)
- `src/config/env.ts` (`VOYAGE_API_KEY` + availability),
  `prisma/schema.prisma`, docs

**Tests:**

- `pnpm typecheck` → 0 errors
- `pnpm lint` → 0 errors, 0 warnings
- `pnpm test` → 214/214 passing (25 files; +38 new: 9 chunker unit, 15
  embedding provider, 11 RAG service, 3 new assertions on the upload →
  auto-index path, 3 more in the provider file's typing)
- `pnpm build` → succeeded
- **Live verification against the running app**: registered a user,
  uploaded a real PDF, confirmed it went READY and was indexed
  automatically, re-indexed on demand, then searched it — the top hit was
  the correct chunk at similarity 0.513 via
  `local-hashing-embedder`, and a gibberish query at a 0.9 floor returned
  `noEvidence: true` with zero hits. Test data removed afterwards.

**Known limitations:**

- With no `VOYAGE_API_KEY` set, retrieval is lexical, not semantic. The
  adapter is written against Voyage's documented request/response shape
  and tested at the HTTP boundary, but the sandbox's network egress
  cannot reach `api.voyageai.com`, so it has never run against the live
  API — same caveat as the Filestack adapter in Phase 14.
- `VOYAGE_API_KEY` was **not** added to `.env.example`: the file tooling
  in this environment refuses to write any `.env*` file. It needs that
  one line added by hand.
- Retrieval returns chunks, not composed answers. Grounding an agent's
  prose in those chunks (and Voyage's reranking) is Phase 17's job.
- Re-indexing rewrites all of a document's chunks in a transaction rather
  than diffing them; fine at this scale, worth revisiting at volume.

**Next phase:** Phase 16 — Risk Engine (weighted deterministic risk
scoring over flight, weather, schedule, and document completeness).

---

## Phase 16 — Risk Engine

**Status:** Not started

---

## Phase 17 — Explainable AI

**Status:** Not started

---

## Phase 18 — Event-Driven Trip Monitor

**Status:** Not started

---

## Phase 19 — Trip Watch

**Status:** Not started

---

## Phase 20 — AI Itinerary Planner

**Status:** Not started

---

## Phase 21 — Frontend Command Center

**Status:** Complete (core product experience)

**Implemented:**

- **Themed landing page** (`src/app/page.tsx`): hero, feature grid,
  product visual, and CTA band. Every primary CTA routes into the auth
  flow (`/login` / `/register`), and `/trips` is the authenticated
  destination.
- **Auth pages** (`src/app/login`, `src/app/register`): client forms that
  post to the existing `/api/auth/login` and `/api/auth/register`
  endpoints, then route to the destination preserved in `?returnTo=...`
  (validated to a local path so a crafted value can't bounce users
  off-site). Register mirrors the server's 12-character minimum
  (`validatePasswordStrength`) inline.
- **Protected trip experience** (`src/app/trips/**`):
  - `requireSession()` (`src/app/require-auth.ts`) resolves the request's
    session via the same `getSessionUser` the API's `requireAuth` uses,
    and redirects anonymous visitors to
    `/login?returnTo=<intended path>`. Applied in the trips layout and in
    every trip page.
  - Trips dashboard: server-rendered list from `listUserTrips`, plus a
    small client island for creating a trip.
  - Trip detail: the full **Trip Digital Twin** rendered server-side from
    `getTripDigitalTwin` + `getTripEventHistory` — destinations (with the
    Weather Agent's "Check weather"), travelers, flights (with the Flight
    Agent's "Check status"), documents, the deterministic operational
    state banner, and the immutable event history. Client islands for
    currency check (Currency Agent) and the research agent.
  - Analytics: live counts computed from the user's own rows — no cached
    or invented metrics.
  - Settings: account details from the real session plus each provider's
    real configured/not-configured state, derived from
    `providerAvailability` (names and booleans only — never key values).
- **Shared UI primitives** (`src/components/ui.tsx`,
  `src/components/auth-shell.tsx`): buttons, fields, badges, cards, the
  `apiRequest`/POST helpers that unwrap the `{ data, requestId }` envelope,
  and the auth shell. Client islands never re-fetch what a server
  component already rendered; they post and call `router.refresh()`.
- **Form-friendly logout** (`src/app/logout/route.ts`): a 303-redirecting
  POST endpoint so the layout's plain `<form method="post">` works with
  no client JS. The JSON endpoint at `/api/auth/logout` remains for
  programmatic clients.
- **Design system**: `src/app/globals.css` defines the full "operations-room
  navy over warm sand" token set (navy/sand/terra scales plus ok/warn/alert
  status tokens) with dark-mode values, wired into Tailwind's
  `@theme inline` so all utilities resolve. No external font or asset
  fetches — the CSP stays intact.

**Files changed:**

- `src/app/page.tsx`, `src/app/layout.tsx`, `src/app/globals.css` (rewritten)
- `src/app/require-auth.ts`, `src/app/logout/route.ts` (new)
- `src/app/login/**`, `src/app/register/**` (new)
- `src/app/trips/**` — layout, dashboard, new-trip island, trip detail +
  actions + operational-state banner, analytics, settings (new)
- `src/components/**` (new)

**Verification:**

- `pnpm typecheck` → 0 errors
- `pnpm lint` → 0 errors, 0 warnings
- `pnpm test` → 159/159 passing (20 files). No backend file was touched
  by this phase; the suites ran against a real local Postgres + Redis.

**Known limitations:**

- The frontend talks to the trip module's public service functions from
  server components (the same layer the API routes use) and to the HTTP
  API from client islands. It does not bypass the module boundary rule —
  it uses the service interface, not repositories directly.
- No document upload UI yet: the documents section renders what the
  digital twin returns, but the upload/storage + extraction pipeline is
  Phase 14 (not started).
- Command bar (Phase 22), observability UI (Phase 23), and the audit-trail
  view (Phase 24) are still ahead.

**Next phase:** Phase 14 — Document Intelligence (backend), with the
frontend surface for it to follow.

---

## Phase 22 — Command Bar

**Status:** Not started

---

## Phase 23 — System Observability UI

**Status:** Not started

---

## Phase 24 — Audit Trail

**Status:** Not started

---

## Phase 25 — Accessibility

**Status:** Not started

---

## Phase 26 — Grid Distortion Integration

**Status:** Not started

---

## Phase 27 — Testing

**Status:** Not started

---

## Phase 28 — Failure Testing

**Status:** Not started

---

## Phase 29 — Performance

**Status:** Not started

---

## Phase 30 — Docker

**Status:** Not started

---

## Phase 31 — CI/CD

**Status:** Not started

---

## Phase 32 — Documentation

**Status:** Not started

---

## Phase 33 — Final Engineering Audit

**Status:** Not started
