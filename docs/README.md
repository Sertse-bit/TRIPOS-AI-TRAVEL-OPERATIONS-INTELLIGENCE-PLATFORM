# TripOS documentation

Where to look, and what each document is responsible for. Everything here
is written against the code as it stands; where a document records a
limitation rather than a capability, it says so.

| Document                                   | Read it for                                                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ARCHITECTURE.md](./ARCHITECTURE.md)       | Module boundaries, the service interface each module exposes, the AI tool layer's execution limits, and the reasoning behind each phase's design — one section per phase (1–31).   |
| [BUILD_PROGRESS.md](./BUILD_PROGRESS.md)   | The phase ledger: what was built, how it was verified, what was deliberately not done, and what comes next. Read the latest entry before adding a phase.                           |
| [API.md](./API.md)                         | The HTTP surface: envelope, error codes, auth, rate limits, and the full route table — enforced against the code by `src/app/api-route-table.test.ts`.                             |
| [DATABASE.md](./DATABASE.md)               | Schema design and how it was actually verified, how to bootstrap an empty database, and the known gaps (no Prisma migrations yet, check constraints that live in the application). |
| [SECURITY.md](./SECURITY.md)               | Threat model, secrets handling, session design, rate limiting, and the honest list of what is not yet enforced.                                                                    |
| [INTEGRATIONS.md](./INTEGRATIONS.md)       | Every provider adapter: real API vs documented mock adapter, resilience behaviour (retries, circuit breaker, cache), and what has been live-verified.                              |
| [ACCESSIBILITY.md](./ACCESSIBILITY.md)     | What was measured against WCAG AA, the contrast failures found and fixed, and what a static check cannot see (no browser in this build environment).                               |
| [AI_ARCHITECTURE.md](./AI_ARCHITECTURE.md) | The agent layer: tool typing, orchestration bounds (8 calls / 30 s / 50 k tokens), and how an answer's claims are tied to tool calls that actually ran.                            |

Repo-level entry points: [../README.md](../README.md) for the overview and
local setup, [../AGENTS.md](../AGENTS.md) for the non-negotiable rules of
this codebase, and the source-tree-level layout in
[ARCHITECTURE.md](./ARCHITECTURE.md).
