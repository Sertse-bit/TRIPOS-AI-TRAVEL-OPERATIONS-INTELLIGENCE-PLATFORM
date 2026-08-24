# TripOS — Architecture

## Status: Phase 1 (System Architecture) Complete

---

## 1. Repository Audit Findings (Phase 0)

As of the initial audit (2026-08-24), the repository
`Sertse-bit/TRIPOS-AI-TRAVEL-OPERATIONS-INTELLIGENCE-PLATFORM` contained no
commits, no files, and no branches other than an unborn `main`. This is a
greenfield project — Phase 0 recorded a stack proposal instead of an
audit of existing code, since none existed.

## 2. Technology Stack (Approved 2026-08-24)

| Concern            | Choice                                  | Rationale |
|---------------------|------------------------------------------|-----------|
| Frontend framework  | Next.js (App Router), TypeScript strict  | Unifies frontend + BFF layer; server components reduce client bundle |
| Package manager     | pnpm                                      | Fast installs, disk-efficient, strict dependency resolution |
| Backend             | Next.js Route Handlers, organized as a modular monolith under `src/modules/*` | Avoids premature microservice split; module boundaries allow future extraction without a rewrite |
| Database            | PostgreSQL                                | Relational integrity for trips/travelers/flights/documents; also hosts vector data |
| ORM / migrations    | Prisma                                    | Strong TypeScript type generation, mature migration tooling |
| Vector storage       | `pgvector` extension on the same Postgres instance | Avoids a second database system before there's evidence it's needed |
| Cache                | Redis                                     | Provider response caching, rate-limit bookkeeping |
| Background jobs / events | BullMQ (Redis-backed queues)         | Lightweight; avoids unnecessary distributed infrastructure |
| Auth                 | Auth.js (NextAuth), credentials provider, database-backed sessions via Prisma adapter | See Section 12 — decided now to support the authentication flow design |
| AI orchestration     | Anthropic API (Claude) via a typed tool-calling layer; LangGraph re-evaluated in Phase 9 only if agent handoff complexity justifies it | No orchestration framework adopted until proven necessary |
| Testing              | Vitest (unit/integration), Playwright (E2E) | TypeScript-native, fast |
| Containerization     | Docker + docker-compose                   | `frontend`, `backend` (same Next.js app initially), `postgres`, `redis`, `worker` |
| CI                   | GitHub Actions                            | install → lint → typecheck → unit → integration → build. No deployment target configured (out of scope per brief). |

## 3. Directory Structure (target for Phase 2)

```text
src/
  modules/          # feature-oriented domain modules (trip, flight, weather, currency, document, risk, ai)
  shared/           # cross-cutting types/utilities genuinely shared across modules
  infrastructure/   # db client, redis client, queue setup, logger
  config/           # centralized, validated environment configuration
  database/         # Prisma schema, migrations, seed scripts
  ai/               # tool definitions, orchestrator, agents
  workers/          # background job handlers
  events/           # event definitions, event bus
  integrations/     # provider adapters (Aviationstack, Weatherstack, etc.)
```

## 4. Decisions Log

| Date | Decision |
|------|----------|
| 2026-08-24 | Stack approved as proposed in Phase 0 (no changes requested). |
| 2026-08-24 | External API keys received for 11 providers (8 from the original brief plus ExchangeRate, Mailboxlayer, Marketstack). See `docs/BUILD_PROGRESS.md` for status; real values live only in git-ignored `.env.local`. |
| 2026-08-24 | `ZENSERP_API_KEY` corrected — original value was a duplicate of `AVIATIONSTACK_API_KEY`; replaced with a UUID-format key consistent with Zenserp's real key convention. No longer blocks the Research Agent (Phase 13). |
| 2026-08-24 | `MARKETSTACK_API_KEY` has no mapped use case in TripOS; left configured but unused. |
| 2026-08-24 | Auth strategy decided: Auth.js with credentials provider + Prisma-backed database sessions (not JWT) — chosen so sessions can be revoked server-side immediately, which matters for a "Security Engineer" pass in Phase 4. |
| 2026-08-24 | CI will not configure a real deployment target, per brief Section 31, unless explicitly requested later. |

---

## 5. Bounded Responsibilities & Service Boundaries

TripOS is a modular monolith: one deployable Next.js application, internally
divided into modules with enforced boundaries. The rule that makes this
real rather than nominal:

> **A module may only be used through its public service interface
> (`modules/<name>/index.ts`). No module imports another module's Prisma
> models, internal files, or database rows directly.** Cross-module
> effects happen either through an explicit service call or through a
> published domain event — never through a shared mutable object or a
> direct query into someone else's tables.

This is the mechanism that keeps the "no circular dependencies, no
accidental coupling" goal (final audit, brief Section 36) achievable later,
rather than aspirational.

| Module | Owns | Explicitly does NOT own | Collaborates with |
|---|---|---|---|
| **Trip Service** | `trips`, `travelers`, `destinations`, trip state transitions | Flight/weather retrieval logic; risk computation | Database; invoked by BFF and by AI tools |
| **User Service** | `users`, profile data | Session/auth mechanics (Auth.js owns that) | Database; invoked by BFF |
| **Flight / Weather / Currency Services** | `flight_records`, `weather_snapshots`, `currency_snapshots` and their persistence | Calling the LLM; deciding what the user should do about a change | Provider adapters (via Tool Layer), Database, Redis |
| **Document Service** | `trip_documents`, `document_chunks`, upload/storage orchestration | Embedding model calls, text-extraction library internals | `DocumentStorageProvider`, Database, pgvector |
| **Risk Engine** | `risk_assessments`, the deterministic scoring model | Natural-language explanation generation (delegated to the Risk Agent for prose only) | Database; consumes Flight/Weather/Document snapshots |
| **AI Orchestrator** | Agent selection, tool-call sequencing, execution limits | Direct DB writes (must go through domain services via tools) | Tool Layer only |
| **AI Tool Layer** | Typed tool contracts, input validation, authorization checks, logging | Agent reasoning/prompting | Domain services, provider adapters |
| **Specialized Agents** | Normalizing provider data into domain snapshots; producing structured, evidence-backed output | Inventing values when provider data is unavailable | Provider adapters via Tool Layer only |
| **Integration Layer** | Vendor HTTP/SDK details, retries, caching, circuit breaking | Domain interpretation of the data it fetches | External APIs, Redis |
| **Event System** | Event definitions, publishing, worker dispatch | Business logic itself (workers call back into domain services, they don't reimplement them) | Redis (BullMQ), domain services |

---

## 6. System Container Diagram

```mermaid
flowchart TB
    subgraph Client["Web Client"]
        UI[Next.js UI]
    end

    subgraph BFF["API / BFF Layer - Route Handlers"]
        AuthMW[Auth Middleware]
        Router[Route Handlers]
    end

    subgraph Domain["Domain Layer - Modular Monolith"]
        TripSvc[Trip Service]
        UserSvc[User Service]
        RiskSvc[Risk Engine]
        DocSvc[Document Service]
    end

    subgraph AI["AI Orchestration Layer"]
        Orchestrator[AI Orchestrator]
        ToolLayer[AI Tool Layer]
        Agents[Flight / Weather / Currency /
Research / Document / Risk / Planning Agents]
    end

    subgraph Data["Data Layer"]
        PG[(PostgreSQL)]
        VectorDB[(pgvector)]
        Redis[(Redis)]
    end

    subgraph Events["Event System"]
        Queue[BullMQ Queues]
        Workers[Background Workers]
    end

    subgraph External["External Providers"]
        Aviation[Aviationstack]
        Weather[Weatherstack]
        Currency[Fixer / ExchangeRate]
        Search[Zenserp]
        Storage[Filestack]
    end

    UI --> Router
    Router --> AuthMW
    AuthMW --> TripSvc
    AuthMW --> UserSvc
    AuthMW --> Orchestrator

    Orchestrator --> ToolLayer
    ToolLayer --> Agents
    Agents --> Aviation
    Agents --> Weather
    Agents --> Currency
    Agents --> Search
    DocSvc --> Storage

    TripSvc --> PG
    UserSvc --> PG
    RiskSvc --> PG
    DocSvc --> PG
    DocSvc --> VectorDB
    ToolLayer -.reads/writes via services.-> Domain

    TripSvc --> Redis
    Agents --> Redis

    TripSvc --> Queue
    Queue --> Workers
    Workers --> RiskSvc
    Workers --> Orchestrator
```

---

## 7. Data Flow (Trip Lifecycle)

Distinct from a single request: this is how data accumulates over a trip's
life and feeds the risk/recommendation pipeline.

```mermaid
flowchart LR
    Trip[Trip record] --> Traveler[Travelers]
    Trip --> Flight[Flight records]
    Trip --> Dest[Destinations]
    Trip --> Doc[Documents]
    Flight --> FlightSnap[Flight snapshots over time]
    Dest --> WeatherSnap[Weather snapshots over time]
    Trip --> CurrencySnap[Currency snapshots]
    Doc --> Chunks[Document chunks + embeddings]
    FlightSnap --> Risk[Risk assessment]
    WeatherSnap --> Risk
    Doc --> Risk
    Risk --> Rec[Recommendations]
    FlightSnap --> Events[trip_events]
    WeatherSnap --> Events
    Risk --> Events
    Rec --> Events
    Events --> Audit[audit_logs]
```

Snapshots are append-only: a new flight/weather/currency check never
overwrites the previous one. State comparison (Section 9) reads the latest
two snapshots rather than mutating a single row — this is what makes
"only meaningful changes generate alerts" (brief Phase 19) possible.

---

## 8. Request Flow

Example: user asks a question through the command bar.

```mermaid
sequenceDiagram
    participant U as User
    participant FE as Next.js Frontend
    participant MW as Auth Middleware
    participant API as Route Handler
    participant ORCH as AI Orchestrator
    participant TOOL as Tool Layer
    participant AGENT as Specialized Agent
    participant EXT as External Provider
    participant DB as PostgreSQL

    U->>FE: Submits command
    FE->>API: POST /api/trips/:id/ask
    API->>MW: Validate session
    MW-->>API: Authenticated user context
    API->>DB: Load trip, verify user owns it
    DB-->>API: Trip record
    API->>ORCH: invoke(question, tripContext)
    ORCH->>TOOL: request tool: get_flight_status
    TOOL->>TOOL: validate input, check authorization
    TOOL->>AGENT: execute
    AGENT->>DB: check cached snapshot
    AGENT->>EXT: fetch live status if cache miss
    EXT-->>AGENT: raw provider response
    AGENT->>AGENT: normalize and compare to prior snapshot
    AGENT-->>TOOL: structured result plus evidence
    TOOL-->>ORCH: tool result
    ORCH->>ORCH: compose explainable response
    ORCH-->>API: Decision, Evidence, Reasoning, Recommendation, Confidence
    API-->>FE: JSON response
    FE-->>U: Rendered answer with evidence
```

---

## 9. Event Flow

Example: a flight status change propagating to a user-visible alert.

```mermaid
flowchart LR
    A[Trip Watch scheduled job] --> B[Flight Agent fetches status]
    B --> C{State changed vs
last snapshot?}
    C -- No --> Z[No-op, idempotent]
    C -- Yes --> D[Persist new snapshot]
    D --> E[Emit FLIGHT_UPDATED]
    E --> F[Queue: Risk Analysis Worker]
    F --> G[Risk Engine recomputes score]
    G --> H{Risk changed
meaningfully?}
    H -- No --> Z
    H -- Yes --> I[Persist risk_assessment]
    I --> J[Emit RISK_CHANGED]
    J --> K[Queue: Recommendation Worker]
    K --> L[AI generates explanation from I's evidence]
    L --> M[Persist recommendation]
    M --> N[Emit RECOMMENDATION_CREATED]
    N --> O[Emit NOTIFICATION_REQUIRED]
    O --> P[Notification Worker]
    P --> Q[Deliver to user, record in audit_logs]
```

Idempotency: every event carries the entity id plus the snapshot id that
triggered it, so a worker retry or duplicate delivery is a safe no-op
rather than a duplicate notification (brief Phase 19's explicit
requirement).

---

## 10. AI Tool Flow & Execution Limits

```mermaid
flowchart TB
    Orchestrator[AI Orchestrator selects a tool by name] --> Registry[Tool Registry - approved tools only]
    Registry --> Validate[Input schema validation]
    Validate -->|invalid| Reject[Structured error back to orchestrator]
    Validate -->|valid| AuthZ[Authorization check: can this user/trip use this tool?]
    AuthZ -->|denied| Reject
    AuthZ -->|allowed| Exec[Execute tool handler]
    Exec --> Bound{Within limits?}
    Bound -->|exceeded| Halt[Halt run, return partial result]
    Bound -->|ok| Log[Structured log plus audit entry]
    Log --> Result[Typed structured output]
    Result --> Orchestrator
```

Concrete limits (starting values, tunable in Phase 9 implementation):

- **Max tool calls per orchestration run:** 8
- **Max wall-clock time per run:** 30 seconds
- **Recursion:** agents never call other agents directly — only
  Orchestrator → Agent → Tool. Depth is capped at 1 by construction, not by
  a runtime counter alone.
- **Logging:** every tool call logs request ID, trip ID, tool name,
  duration, and outcome, regardless of success or failure.

---

## 11. Error Propagation

```mermaid
flowchart TB
    E[Error occurs] --> Class{Error class}
    Class -->|Validation| V[400 plus field-level details]
    Class -->|Auth| A[401 or 403, no detail leak]
    Class -->|Not Found| N[404]
    Class -->|Provider failure| PFail[Structured ProviderError]
    PFail --> Retry{Retryable and budget left?}
    Retry -->|yes| Backoff[Retry with backoff]
    Retry -->|no| Degrade[Degraded-mode response, marked stale]
    Class -->|Unexpected| Unexp[500, generic message to client]
    V --> Log[Structured log with request ID]
    A --> Log
    N --> Log
    Degrade --> Log
    Unexp --> Log
    Log --> Envelope[Consistent API error envelope]
```

Standard envelopes (finalized in Phase 2, contract fixed now):

```json
// Success
{ "data": { "...": "..." }, "requestId": "req_abc123" }

// Error
{
  "error": {
    "code": "TRIP_NOT_FOUND",
    "message": "Trip not found.",
    "requestId": "req_abc123"
  }
}
```

Client-facing error messages never include stack traces, provider raw
responses, or internal identifiers beyond the request ID — full detail
goes to structured server-side logs only, correlated by that same request
ID.

---

## 12. Authentication Flow

```mermaid
sequenceDiagram
    participant U as User
    participant FE as Frontend
    participant API as Auth Route - Auth.js
    participant DB as PostgreSQL
    participant MW as Middleware

    U->>FE: Submit email and password
    FE->>API: POST credentials callback
    API->>DB: Look up user by email
    DB-->>API: user record with hashed password
    API->>API: verify password hash
    alt invalid credentials
        API-->>FE: 401 Unauthorized
    else valid credentials
        API->>DB: create session row
        DB-->>API: session id
        API-->>FE: Set-Cookie, httpOnly, secure, sameSite
    end

    Note over U,MW: Subsequent requests
    U->>FE: Navigate or call API
    FE->>MW: Request with session cookie
    MW->>DB: validate session not expired or revoked
    alt valid session
        MW-->>API: attach user context, continue
    else invalid or expired
        MW-->>FE: 401, redirect to login
    end
```

Database-backed sessions (not JWT) were chosen specifically so a session
can be revoked server-side immediately — relevant to the Phase 4 security
pass and worth being able to demonstrate ("log out everywhere" / admin
session revocation) in a portfolio project.

---

## 13. Document-Processing Flow (Architecture Level)

Full pipeline detail (chunking strategy, embedding model, extraction
libraries) belongs to Phase 14–15. This is the system-level shape only.

```mermaid
flowchart TB
    U[User uploads file] --> V[Validation: type, size, MIME sniff]
    V -->|invalid| R[Reject: structured error]
    V -->|valid| S[Store original via DocumentStorageProvider]
    S --> P[Persist trip_documents row, status UPLOADED]
    P --> EV1[Emit DOCUMENT_UPLOADED]
    EV1 --> Q[Queue: Document Processing Worker]
    Q --> EXTRACT[Text extraction]
    EXTRACT --> CLEAN[Cleaning and normalization]
    CLEAN --> META[Structured metadata extraction]
    META --> CHUNK[Chunking]
    CHUNK --> EMBED[Embedding generation]
    EMBED --> VSTORE[(pgvector: document_chunks)]
    VSTORE --> DONE[Update trip_documents, status READY]
    DONE --> EV2[Emit DOCUMENT_PROCESSED]
    EV2 --> RAG[Available for RAG retrieval]
```

If extraction fails partway, `trip_documents.status` moves to `FAILED`
with a reason, not silently to `READY` — the brief is explicit that
successful extraction must never be claimed unless it actually happened.

---

## 14. Explicitly Deferred to Later Phases

Phase 1 defines shape and boundaries, not implementation detail. Not
decided here, on purpose:

- Exact retry counts / backoff curve per provider → Phase 6
- Risk scoring formula and factor weights → Phase 16
- Embedding model and chunking parameters → Phase 15
- Exact Redis key/TTL scheme → Phase 6 and Phase 12
- Rate-limit thresholds per route → Phase 4
- Docker service resource limits → Phase 30

---
