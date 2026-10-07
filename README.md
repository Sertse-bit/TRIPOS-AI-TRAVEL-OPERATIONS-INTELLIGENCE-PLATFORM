# TripOS — AI Travel Operations & Intelligence Platform

TripOS turns a travel itinerary into a live **operational picture**. Each
trip is a _digital twin_ — destinations, travelers, flights, and documents
— continuously enriched by specialized provider agents (flight status,
weather, currency) and a research agent grounded in live search results.
Everything surfaces as an explainable operational state, never an invented
metric.

## Stack

- **Next.js 16** (App Router, React 19, TypeScript strict)
- **PostgreSQL** via raw `pg` repositories (Prisma schema in `prisma/`), with **pgvector** for document embeddings
- **Redis** (rate limiting, resilience cache)
- **Anthropic** SDK behind a typed, bounded AI tool layer
- **Tailwind CSS v4** with a project-specific theme token set
- Vitest for tests (464 tests across 46 files, real Postgres/Redis where
  database properties matter); pnpm for package management

## What works today

- **Auth** — DB-backed sessions (hashed tokens), cookie-based,
  revocable. Credentials-only, with login rate limiting (IP + email).
- **Trip Digital Twin** — create/manage trips, travelers, destinations,
  flights; immutable per-trip event history.
- **Provider agents** — Flight (Aviationstack), Weather (Weatherstack),
  Currency (Fixer + ExchangeRate fallback), each recording timestamped,
  append-only snapshots. Documented mock adapters stand in when a
  provider key isn't configured — a real adapter is never faked.
- **Document intelligence** — upload PDFs or images straight from the
  trip page (content-sniffed bytes, 10MB cap). PDFs get real text
  extraction plus evidence-backed metadata (flight numbers, dates,
  booking references), each shown with the text it was found in; images
  are stored honestly as not-text-extracted (no OCR in this build), and
  nothing is ever marked READY unless extraction actually happened.
- **RAG retrieval** — extracted document text is chunked deterministically
  and embedded into a real `pgvector` column, then searched by cosine
  similarity within the trip. Without a `VOYAGE_API_KEY` it falls back to
  a local hashing embedder that is genuinely lexical rather than
  semantic, and says so in every result instead of pretending otherwise.
- **Risk engine** — a deterministic weighted score (flight disruption,
  weather, schedule proximity, itinerary and document readiness) computed
  as a pure function over real stored data, so the same inputs always
  produce the same score. No model writes the number. Data that doesn't
  exist is reported as a gap instead of being scored as "no risk", and a
  cancelled flight floors severity at CRITICAL.
- **Explainable recommendations** — an agent turns that stored score
  into prose, and only prose. Every claim must cite a factor the
  assessment actually produced (checked in code, not just prompted), its
  confidence is capped by the assessment's own data coverage, and it is
  stored linked to the exact score it explains. Requires an
  `ANTHROPIC_API_KEY`; without one the feature says so plainly rather
  than inventing an explanation.
- **Event-driven trip monitor** — re-checks every flight and destination
  against its provider, recomputes risk, and alerts only when the risk
  genuinely changes. A failed check is reported as failed, never as
  unchanged, and repeated passes over an unchanged trip stay silent:
  dedupe is enforced by a unique index, not a racy read-then-write.
- **Trip Watch** — automatic monitoring on a cadence you choose: 5–1440
  minutes per trip, opt-in, with an alert floor ("only interrupt me at
  CRITICAL"). A sweep claims each due watch atomically, so two sweeps
  racing (a scheduler and a button click) still produce exactly one
  provider pass; a failed pass is recorded and retried on the next
  cadence instead of hot-looping, and a trip that reaches COMPLETED or
  CANCELLED stops being watched with a `WATCH_PAUSED` event explaining
  why. The sweep is exposed as `POST /api/watches` (caller-scoped) and
  the service is scheduler-safe — see `docs/BUILD_PROGRESS.md` for why
  no worker process exists yet.
- **Itinerary & budget** — a day-by-day plan per trip with
  deterministic budget validation: recorded costs are totalled per
  currency, converted to the trip's cap through the live FX providers
  with every rate and its timestamp shown, and items with no recorded
  cost are counted as such instead of being silently treated as zero
  (one unavailable rate withholds the converted total entirely rather
  than presenting a partial sum). The **planning agent** composes
  schedules from the trip's real dates, destinations, weather, search
  results, and documents — but every date and city is checked in code
  against the trip before anything is persisted, the agent has no write
  tool and no cost field in its output schema (a model cannot invent a
  price by construction), and re-planning replaces only its own previous
  items. Without an `ANTHROPIC_API_KEY` the planner says so plainly
  while everything deterministic stays available.
- **Command bar** — ask the running trip anything in plain language at
  `POST /api/trips/[id]/ask` (the trip page renders it at the top): the
  answer comes back as decision, recommended action, reasoning, and a
  per-claim evidence list, and **every evidence entry must name a tool
  the run actually called** — the orchestrator records the real call
  trail, and an answer citing a check that never happened is rejected in
  code rather than displayed with invented provenance. The agent is
  strictly read-only (no write tool is even offered), and the panel
  shows the real ✓/✗ trail, call count, and duration. Without an
  `ANTHROPIC_API_KEY` it refuses plainly instead of answering from
  nothing.
- **Frontend command center** — themed landing page, sign-in/register,
  trips dashboard, trip detail with live agents, a risk card showing
  every factor's points and the real values behind them, saved
  recommendations, a notifications inbox, a Trip Watch console at
  `/trips/watches` (every watch's real next/last run state, including its
  last failure, plus a due-check sweep), analytics computed from your own
  rows, and a settings page showing real provider availability.
- **System observability** — a deployment-level panel at
  `/trips/observability` with live, latency-measured database and Redis
  checks and a per-provider view assembled from real records only: the
  health row the resilience layer wrote on each actual call (or an
  honest “never exercised”), the in-process circuit state, and whether
  a key is configured. No CPU/memory graphs, because no metrics
  pipeline exists — and the page says so instead of faking one.
- **Audit trail** — who did what on your trips: every audited change
  (trip edits, destinations, flights, travelers, budget, itinerary,
  documents, Trip Watch settings) plus agent deliveries that were
  actually persisted and watch-sweep passes, attributed honestly to
  USER / AI_AGENT / SYSTEM. Browse all of it at `/trips/audit` or a
  single trip's recent activity on its page; each row carries the
  request ID that produced it, the same one in the API envelope and the
  server logs. Reads are never logged, and nothing is ever back-filled.

- **Accessibility (Phase 25)** — measured, not assumed: WCAG AA contrast
  is enforced for the theme's text tokens in both light and dark mode, a
  skip link and landmarks give keyboard users a way past the nav, the
  current page is marked with `aria-current`, submit buttons announce
  their busy state, form results are live regions, and the OS
  reduced-motion setting is honoured. `docs/ACCESSIBILITY.md` records the
  failures this found (dark mode's headings were 1.06:1 — invisible) and
  what a static check still cannot see.

See `docs/BUILD_PROGRESS.md` for phase-by-phase status and
`docs/ARCHITECTURE.md` for the architecture.

## Local setup

Infra (per `AGENTS.md`):

```bash
service postgresql start
redis-server --daemonize yes --port 6379
```

The database also needs the **pgvector** extension for the RAG phase:

```bash
psql -d tripos_dev -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

If your Postgres doesn't package pgvector, build it from source against
`postgresql-server-dev-<version>` — see `docs/DATABASE.md` for the exact
column and index DDL, including the `trip_watches` table the Trip Watch
phase adds (also committed as executable DDL in
`prisma/sql/phase-19-trip-watch.sql`) and the `itinerary_items` table
plus trip budget columns from
`prisma/sql/phase-20-itinerary-planner.sql`.

Install and configure:

```bash
pnpm install
# Copy .env.example to .env.local and fill in values (see below)
```

Environment variables live in `.env.local` (git-ignored). Required:
`DATABASE_URL`, `AUTH_SECRET` (32+ chars), `REDIS_URL`. Provider keys
(`ANTHROPIC_API_KEY`, `AVIATIONSTACK_API_KEY`, `WEATHERSTACK_API_KEY`,
`FIXER_API_KEY`, `EXCHANGERATE_API_KEY`, and the supporting providers) are
optional — unconfigured providers use their mock adapters, except
`ANTHROPIC_API_KEY`, which has no mock by design: risk scoring works
without it, and only the natural-language explanations need it.

Run:

```bash
pnpm dev        # http://localhost:3000
pnpm typecheck  # tsc --noEmit
pnpm lint       # eslint
pnpm test       # vitest run
```

The app fails fast at startup if `DATABASE_URL` or `AUTH_SECRET` is
missing — a misconfigured environment should not limp into confusing
runtime errors later.

## Conventions

- Every API route goes through `withApiHandler` for a consistent
  `{ data, requestId }` / `{ error }` envelope.
- Modules talk to each other only through their public service interface
  or a domain event.
- Secrets are server-side only; nothing sensitive is prefixed with
  `NEXT_PUBLIC_`.
- Raw SQL touching enum columns casts explicitly
  (e.g. `'DEGRADED'::"ApiHealthStatus"`).
