# TripOS — Architecture

## Status: Phase 0 (Repository Audit) Complete

## 1. Repository Audit Findings

As of the initial audit (2026-08-24), the repository
`Sertse-bit/TRIPOS-AI-TRAVEL-OPERATIONS-INTELLIGENCE-PLATFORM` contained:

- No commits
- No files
- No branches other than an unborn `main`

There was no existing framework, package manager, TypeScript configuration,
directory structure, styling system, database configuration, Docker setup,
CI/CD configuration, or AI integration to audit or preserve. This is a
greenfield project.

**Implication:** Phase 0 could not include an "existing strengths / existing
problems / reusable components" analysis, since there was nothing to analyze.
Instead, Phase 0 records the initial technology decisions that Phase 1–2
will build on, so this document doubles as the record of that decision.

## 2. Target Technology Stack (proposed, pending approval)

| Concern            | Choice                                  | Rationale |
|---------------------|------------------------------------------|-----------|
| Frontend framework  | Next.js (App Router), TypeScript strict  | Unifies frontend + BFF layer; server components reduce client bundle; good fit for the "command center" UI described in the brief |
| Package manager     | pnpm                                      | Fast installs, disk-efficient, strict dependency resolution (catches phantom deps early) |
| Backend             | Next.js Route Handlers initially, organized as a modular monolith under `src/modules/*` | Avoids premature microservice split (per brief, Section 4); module boundaries are designed so a module could be extracted into its own service later without a rewrite |
| Database            | PostgreSQL                                | Relational integrity for trips/travelers/flights/documents; also hosts vector data |
| ORM / migrations    | Prisma                                    | Strong TypeScript type generation, mature migration tooling |
| Vector storage       | `pgvector` extension on the same Postgres instance | Avoids adding a second database system before there's evidence it's needed |
| Cache                | Redis                                     | Provider response caching, rate-limit bookkeeping |
| Background jobs / events | BullMQ (Redis-backed queues)         | Lightweight, avoids unnecessary distributed infrastructure (Kafka etc. explicitly out of scope per brief) |
| Auth                 | TBD in Phase 4 — likely NextAuth/Auth.js with credentials + session/JWT strategy | Deferred until Phase 4 for a dedicated security-focused pass |
| AI orchestration     | Anthropic API (Claude) via a typed tool-calling layer; LangGraph evaluated in Phase 9 if agent handoff complexity justifies it | Per brief Section 12 — no orchestration framework adopted until proven necessary |
| Testing              | Vitest (unit/integration), Playwright (E2E) | TypeScript-native, fast |
| Containerization     | Docker + docker-compose                   | `frontend`, `backend` (initially same Next.js app), `postgres`, `redis`, `worker` |
| CI                   | GitHub Actions                            | install → lint → typecheck → unit → integration → build |

This table is a proposal for Phase 1 approval, not a final decision — flag
here if any of these should change before scaffolding begins.

## 3. Conceptual Target Architecture

```text
                         WEB CLIENT
                             │
                             ▼
                   NEXT.JS / FRONTEND
                             │
                             ▼
                    API / BFF LAYER
                             │
             ┌───────────────┼────────────────┐
             │               │                │
             ▼               ▼                ▼
        TRIP SERVICE    AI ORCHESTRATOR   USER SERVICE
             │               │
             │               ▼
             │        SPECIALIZED AGENTS
             │          ├─ Flight
             │          ├─ Weather
             │          ├─ Currency
             │          ├─ Research
             │          ├─ Document
             │          ├─ Risk
             │          └─ Planning
             │
             ▼
         DOMAIN LAYER
             │
      ┌──────┼──────────┐
      ▼      ▼          ▼
 PostgreSQL Redis     Event System
      │
      ▼
  VECTOR STORAGE (pgvector)
      │
      ▼
     RAG
      │
      ▼
 EXTERNAL APIs
```

Detailed service boundaries, request/event/AI-tool flow diagrams, and the
authentication flow will be added in Phase 1 once the stack above is
confirmed.

## 4. Directory Structure (proposed for Phase 2)

```text
src/
  modules/          # feature-oriented domain modules (trip, flight, weather, currency, document, risk, ai)
  shared/           # cross-cutting types, utilities genuinely shared across modules
  infrastructure/   # db client, redis client, queue setup, logger
  config/           # centralized, validated environment configuration
  database/         # Prisma schema, migrations, seed scripts
  ai/               # tool definitions, orchestrator, agents
  workers/          # background job handlers
  events/           # event definitions, event bus
  integrations/     # provider adapters (Aviationstack, Weatherstack, etc.)
```

## 5. Open Questions for Phase 1 Approval

1. Confirm stack choices in Section 2 (especially Prisma vs. Drizzle, and
   NextAuth vs. custom auth).
2. Confirm which external API keys you already hold (Aviationstack,
   Weatherstack, Fixer/ExchangeRate Host, IPstack, Numverify, Zenserp,
   Filestack, Screenshotlayer) so mock adapters can be scoped correctly for
   any that are unavailable during development.
3. Confirm deployment target is out of scope for CI/CD (per brief Section
   31 — no real deployment provider will be configured unless requested).
