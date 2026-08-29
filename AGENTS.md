# Working on TripOS

Read `docs/BUILD_PROGRESS.md` first — it says exactly which phase is done
and what's next. Read `docs/ARCHITECTURE.md` before touching module
boundaries, the AI tool layer, or auth.

## Non-negotiable rules (from the original project brief)

- Never fake a provider API response, invented metric, or invented user
  data. If a provider is unavailable, use a documented mock adapter and
  say so — don't simulate success.
- Modules only talk to each other through a public service interface
  (`modules/<name>/index.ts`) or a domain event. Never import another
  module's Prisma models or internal files directly.
- All external API keys are server-side only (`src/config/env.ts`). Never
  prefix one with `NEXT_PUBLIC_`.
- AI agents only act through the typed Tool Layer (`src/ai/tools`) —
  never given direct DB or shell access. See docs/ARCHITECTURE.md Section
  10 for the concrete execution limits (8 tool calls/run, 30s cap, no
  agent-to-agent recursion).
- Every route handler goes through `withApiHandler` (`src/shared/api-response.ts`)
  so the success/error envelope and request ID stay consistent everywhere.
- Real secrets live in `.env.local` only, which is git-ignored. Only
  `.env.example` (names, no values) is committed.
- **Raw SQL against enum columns needs an explicit cast**, e.g.
  `'DEGRADED'::"ApiHealthStatus"`. Postgres's type inference can fail
  silently at the SQL-string level (never caught by TypeScript) when an
  unquoted-type string literal appears inside a `CASE` expression or
  alongside `ON CONFLICT ... DO UPDATE` — found the hard way in
  `api-health-repository.ts` (Phase 6) via a real Postgres test failure,
  not by inspection. Every future repository touching an enum column
  (Trip, Flight, Document, Risk, Recommendation all have one) should cast
  explicitly from the start rather than rediscover this.

## Commands

```bash
pnpm dev            # run the app
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint
pnpm test           # vitest run
pnpm db:migrate     # prisma migrate dev
pnpm db:studio      # prisma studio
```

## Local infra for development

Postgres (with pgvector) and Redis are expected at the URLs in
`.env.local`. If they're not running:

```bash
service postgresql start
redis-server --daemonize yes --port 6379
```

## Process

This project is built in phases (see the original brief in
`docs/BUILD_PROGRESS.md` history / conversation). Each phase should leave
the repo in a genuinely working state — real tests passing, not skipped —
before moving to the next one.
