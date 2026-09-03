# TripOS — AI Architecture

## Status: Phase 9 (AI Orchestrator) Complete

This document covers the AI tool layer and orchestrator. It will grow
further with the specialized agents (Phases 10–13, 16–17, 20).

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

## The Orchestrator (Phase 9)

`src/ai/orchestrator.ts`'s `runAgent()` is the actual mechanism that runs
one `AgentDefinition` (`src/ai/agents/types.ts`) through a real Claude
tool-use loop. The 7 specialized agents the brief names are Phases
10–13/16–17/20's job to define using this framework — this phase built
the loop and the hard limits, plus a minimal test-fixture agent to prove
the mechanism itself works, not the specialized agents' domain logic.

### The loop

```text
runAgent(agent, userMessage, toolContext, limits?)
  │
  ├─ build Anthropic tool schemas for agent.allowedTools (Zod → JSON
  │  Schema via z.toJSONSchema()) plus one more: provide_final_answer,
  │  whose schema is agent.outputSchema
  │
  loop:
    ├─ elapsed > maxWallClockMs? ──▶ { success: false, reason: TIMEOUT }
    ├─ tokensUsed > maxTokenBudget? ──▶ { success: false, reason: TOKEN_BUDGET_EXCEEDED }
    ├─ call the real Anthropic API (or return API_ERROR if the call itself fails)
    ├─ no tool_use in the response? ──▶ { success: false, reason: MODEL_STOPPED_WITHOUT_ANSWER }
    └─ for each tool_use block:
          ├─ name === provide_final_answer?
          │     ├─ validates against agent.outputSchema? ──▶ { success: true, data }
          │     └─ invalid? feed the validation issue back as an error
          │         tool_result, giving the model one more turn to correct
          │         itself within the remaining budget — not an immediate failure
          └─ otherwise: toolCallsUsed++; > maxToolCalls? ──▶ { success: false,
              reason: MAX_TOOL_CALLS_EXCEEDED }
              : execute via ai/tools/registry.ts's callTool() (Phase 8),
                feed the real structured result (success or failure) back
                as a tool_result
```

Defaults match what `docs/ARCHITECTURE.md` Section 10 already specified
back in Phase 1 (8 tool calls, 30s wall-clock) — honored rather than
reinvented — plus a 50,000-token cumulative budget added now that "token
usage where applicable" needed a concrete number. All three are
injectable per call (not hardcoded constants used directly), specifically
so tests can exercise the timeout/budget paths in milliseconds instead of
waiting out the real 30-second limit; the production defaults are
unchanged either way.

**No agent-to-agent recursion is possible by construction, not merely
disallowed by convention**: the only thing a tool-use block can trigger
is a call to `callTool()`, and `callTool()` can only execute a registered
_tool_ (Phase 8) — there is no code path anywhere that invokes another
agent from inside a running one.

### A tool failure is data, not a crash

When `callTool()` returns `{success: false, ...}` (e.g. a genuinely
nonexistent trip ID), that structured result is serialized straight into
the tool_result sent back to the model, marked `is_error: true`. The
model sees a real, specific error and can react to it — apologize, ask
for clarification, try a different approach — rather than the whole
agent run crashing. Verified with a real failure, not a mocked one: a
test deliberately requests `get_trip` with a nonexistent ID, confirms
the genuine `NOT_FOUND` error reached the second message sent to the
model, and the run still completes successfully once the model
acknowledges it.

### Verification status

Like every other external provider in this build, there's no real
`ANTHROPIC_API_KEY` available in this sandbox to test a genuine live
call against. Unlike the travel provider domains, `api.anthropic.com`
_is_ actually reachable from this sandbox's network allowlist — the gap
here is a credential, not a network restriction. Every test mocks only
the Anthropic API boundary (`@anthropic-ai/sdk`'s `messages.create`);
everything downstream — the tool registry, trip ownership checks, and
Postgres — is genuinely real. Live end-to-end verification (confirming
the actual Anthropic API responds to these exact tool schemas the way
the mocked tests assume) needs a real key.

## The Flight Agent (Phase 10)

`src/ai/agents/flight-agent.ts` is deliberately **not** an
`AgentDefinition` run through Phase 9's orchestrator. Re-reading this
phase's actual responsibilities — retrieve, normalize, determine state,
compare against the previous snapshot, emit an event on meaningful
change — none of it is a reasoning or generation task. Routing it
through an LLM would be exactly what the brief's Section 37 warns
against directly: "use AI where deterministic logic is better." (Phase
16's Risk Engine is the deliberate counter-example: a deterministic
score with an AI explanation layered on top. This agent has no such
layer because nothing here benefits from one.)

### The status vocabulary mismatch, made explicit

Aviationstack's normalized status (`scheduled/active/landed/cancelled/
incident/diverted/unknown`, from Phase 5) does not line up one-to-one
with this domain's `FlightStatus` enum (`UNKNOWN/SCHEDULED/DELAYED/
CANCELLED/LANDED/COMPLETED`, fixed at the database level since Phase 3).
`mapProviderStatusToFlightStatus()` is the explicit reconciliation:

- **DELAYED is derived from delay minutes, not the raw status string** —
  a flight can be `"active"` (airborne) and still be meaningfully
  delayed. A 15-minute threshold (matching common on-time-performance
  conventions) avoids flagging a two-minute variance as a disruption.
- `"incident"` and `"diverted"` both map to `CANCELLED` — neither has its
  own slot in this domain's enum, and both represent the same
  operational signal a traveler actually needs: the flight isn't
  proceeding as planned.
- `COMPLETED` is not derived from provider data at all — Aviationstack
  has no signal for "landed, deplaned, and fully done" beyond `"landed"`
  itself. Left for a later phase if that distinction ever matters.

### Two-layer design

`processFlightStatusUpdate(flightRecordId)` is the pure domain
operation — no `userId`, no authorization — because Phase 19's Trip
Watch will call this directly while iterating over every monitored
flight across every trip, not on behalf of one user's request.
`runFlightAgentForUser(tripId, flightRecordId, userId)` wraps it with the
Phase 7 ownership check for the case that exists right now: a
user-triggered manual check (`POST /api/trips/[id]/flights/[flightId]/
check-status`).

### Never invents flight data

If the provider returns no matching flight at all (as opposed to
failing), the agent records `UNKNOWN` rather than skipping the check
silently — "we checked and found nothing" is itself meaningful and
belongs in the append-only history, not indistinguishable from "never
checked." If the provider call fails outright, this throws (via the
Phase 6 resilience layer) rather than fabricating a plausible-looking
status — verified live, not just asserted: a real call against the real,
sandbox-unreachable Aviationstack API returned a genuine 403,
correctly classified as non-retryable, and surfaced as a clean
`PROVIDER_ERROR` — the flight status was never invented to paper over
the failure.

### Idempotent event emission

Only a genuinely different status from the previous snapshot emits a
`FLIGHT_UPDATED` event — the brief's own distinction between "checked"
and "meaningfully changed." The event's dedupe key ties to the exact
snapshot that triggered it
(`flight_updated:{flightRecordId}:{snapshotId}`, per Phase 1/3's
idempotency design), so a retry of the same check can never double-emit.

## The Weather Agent (Phase 11)

`src/ai/agents/weather-agent.ts` follows the Flight Agent's shape —
deterministic, no LLM anywhere in the file — for the same reason, stated
even more directly for this phase: "Do not allow the LLM to invent
numerical weather values." There is no LLM here to invent anything;
every number in a `WeatherAgentResult` traces directly back to the
provider response.

### A deliberately different first-reading policy from the Flight Agent

The Flight Agent treats any first-ever reading as "changed" (`null →
SCHEDULED` is itself new, useful information — the flight's status was
previously unknown). Weather doesn't have the same property: an
unremarkable baseline reading ("22°C, sunny") isn't news the way a
flight's first confirmed status is, so establishing it doesn't emit an
event. A **severe** first reading does — `detectSignificantWeatherChange()`
checks the current condition against a documented (explicitly
non-exhaustive) list of severe-weather keywords regardless of whether
there's a previous snapshot to compare against, and separately checks
temperature (8°C), wind speed (20 kph), and precipitation-state deltas
only when a previous reading actually exists. This asymmetry between the
two agents is deliberate, not an inconsistency — see
`docs/BUILD_PROGRESS.md`'s Phase 11 entry for the full reasoning.

### Never invents weather data

Unlike the Aviation provider (which can return "no matching flight" as a
distinct, non-error case), the Weather provider either succeeds or
throws — there's no "no data" middle ground to represent. A provider
failure propagates as a thrown `ProviderError`; nothing gets recorded in
its place. Verified live: a real call against the real, sandbox-blocked
Weatherstack API returned a genuine 403, correctly classified as
non-retryable, and surfaced as a clean `PROVIDER_ERROR` with zero rows
written to `weather_snapshots`.
