# TripOS — AI Architecture

## Status: Phase 8 (AI Tool Layer) Complete

This document covers the AI tool layer. It will grow with Phase 9
(Orchestrator) and the specialized agents (Phases 10–13, 16–17, 20).

## The core security principle

**`userId` is always injected from the authenticated session context.
It is never part of a tool's LLM-facing input schema, and never
something the model supplies.**

A tool's input schema does include a `tripId` — that's how the model
tells the system _which_ trip it means. But _who is asking_ is never
something the model gets to specify. This matters because an LLM's
tool-call arguments aren't fully trustworthy input: a prompt injection
(for instance, hidden instructions inside a document an agent is
summarizing, once Phase 14 exists) could try to manipulate the model into
calling a tool with someone else's `tripId`. Because authorization always
runs against the real, server-side `userId` — never a value the model
provided — that attempt fails the identical way a genuine mistake would:
`requireOwnedTrip()` (Phase 7) throws `NotFoundError` regardless of
which `tripId` was requested or why.

This is verified, not just designed — see `src/ai/tools/registry.test.ts`:
a call to `get_flight_status` with a real flight ID belonging to a trip
the caller doesn't own fails the same way whether the caller made an
honest mistake or is a compromised/confused model acting on injected
instructions elsewhere in the system.

## The approved-tools-only boundary

`src/ai/tools/registry.ts`'s `TOOL_REGISTRY` map **is** the boundary the
brief means by "the AI layer should interact only with approved tools."
There is no code path anywhere that can execute a tool by name unless
it's a key in that object — an orchestrator (Phase 9) can only ever
offer the model tool schemas built from this fixed list; nothing can
register a new one at runtime. `callTool()` checks membership before
anything else, and an unrecognized name is rejected before validation,
authorization, or execution are even attempted.

## Every tool's execution path

```text
callTool(name, rawInput, context)
  │
  ├─ name in TOOL_REGISTRY? ──no──▶ { success: false, error: UNKNOWN_TOOL }
  │
  ├─ inputSchema.safeParse(rawInput) ──fails──▶ { success: false, error: VALIDATION_ERROR }
  │
  ├─ execute(parsedInput, context)
  │     — context.userId is server-injected, never from rawInput
  │     — authorization (e.g. requireOwnedTrip) happens inside execute,
  │       using context.userId
  │
  ├─ throws an AppError ──▶ { success: false, error: { code, message } } (logged)
  ├─ throws anything else ──▶ { success: false, error: INTERNAL_ERROR } (full detail logged server-side only)
  └─ resolves ──▶ { success: true, data }
```

A tool failure is always a `ToolResult`, never a thrown exception that
could crash an agent loop mid-run — the same "structured errors, not
exceptions" principle as `withApiHandler` (Phase 2), applied here because
tool results may eventually be shown back to the model or logged
elsewhere, not just returned to an HTTP client.

## The 10 tools, and their honest scope

| Tool                    | What it actually does                                                                                                                     | What it deliberately doesn't do yet                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_trip`              | Returns the full digital twin (Phase 7)                                                                                                   | —                                                                                                                                                                     |
| `get_trip_documents`    | Lists attached document metadata                                                                                                          | Return document _content_ — that's `search_trip_knowledge`, once Phase 15 exists                                                                                      |
| `get_flight_status`     | Live status via the resilient Aviation provider (Phase 5/6), for a flight that must already belong to the given trip                      | Persist a new snapshot or compare it to the previous one — that's Phase 10's Flight Agent                                                                             |
| `get_weather`           | Live conditions via the resilient Weather provider, for a destination on the given trip                                                   | Persist a snapshot — Phase 11's job                                                                                                                                   |
| `get_currency_rate`     | Live rate via the resilient, dual-vendor Currency provider                                                                                | —                                                                                                                                                                     |
| `search_destination`    | Web search via Zenserp, returns titles/URLs/snippets                                                                                      | Present results as verified fact without a source — that discipline belongs to Phase 13's Research Agent when it composes an answer from this tool's output           |
| `search_trip_knowledge` | Honestly reports whether documents exist and whether any have finished processing                                                         | Any actual retrieval — there is no embedding pipeline yet (Phase 15). Returns `{status: "no_documents"}` or `{status: "not_yet_processed"}`, never a fabricated match |
| `calculate_budget`      | A real, deterministic currency conversion (the multiplication happens in code, never asked of the model)                                  | Estimate a full trip cost — there's no flight/hotel/activity price data model yet. That's Phase 20's job once one exists                                              |
| `create_recommendation` | Persists a real row matching Phase 17's four-part structure (Decision/Evidence/Reasoning/Recommendation) with a bounds-checked confidence | Generate the recommendation's content itself — an agent (Phase 9+) decides what to say; this tool only validates and persists it                                      |
| `create_alert`          | Persists exactly one notification when called                                                                                             | Any throttling or dedup — Phase 19 (Trip Watch) owns "avoid notification spam" for the repeated-automated-check case this tool doesn't have yet                       |

Every tool is trip-scoped (takes a `tripId`, checks ownership) for a
uniform authorization model, even `get_currency_rate` and
`calculate_budget`, where the underlying data isn't inherently private —
consistency across all 10 tools matters more here than optimizing away
an ownership check on the two where it's technically not required for
privacy.

## What's deferred to Phase 9

Per-orchestration-run limits (max tool calls, wall-clock timeout, no
agent-to-agent recursion — already specified in `docs/ARCHITECTURE.md`
Section 10) are the **orchestrator's** job, not each tool's. This layer
defines what a tool is allowed to do and to whom; Phase 9 decides how
many times a model gets to call them in one run.
