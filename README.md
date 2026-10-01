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
- Vitest for tests; pnpm for package management

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
- **Frontend command center** — themed landing page, sign-in/register,
  trips dashboard, trip detail with live agents, a risk card showing
  every factor's points and the real values behind them, and saved
  recommendations, analytics computed from your own rows, and a settings
  page showing real provider availability.

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
column and index DDL.

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
