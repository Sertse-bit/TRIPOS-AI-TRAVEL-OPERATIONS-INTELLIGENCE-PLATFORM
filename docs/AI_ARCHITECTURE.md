# TripOS — AI Architecture

## Status: Phase 22 (Command Bar) Complete — 8 agents built

This document covers the AI tool layer, the orchestrator, the 7
specialized agents (Phases 10–13, 16–17, 20), and the generalist Command
Agent (Phase 22) built on top of them.

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

## The 13 tools, and their honest scope

| Tool                    | What it actually does                                                                                                                                           | What it deliberately doesn't do yet                                                                                                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_trip`              | Returns the full digital twin (Phase 7)                                                                                                                         | —                                                                                                                                                                                                                                                                          |
| `get_trip_documents`    | Lists attached document metadata                                                                                                                                | Return document _content_ — that's `search_trip_knowledge`, once Phase 15 exists                                                                                                                                                                                           |
| `get_flight_status`     | Live status via the resilient Aviation provider (Phase 5/6), for a flight that must already belong to the given trip                                            | Persist a new snapshot or compare it to the previous one — that's Phase 10's Flight Agent                                                                                                                                                                                  |
| `get_weather`           | Live conditions via the resilient Weather provider, for a destination on the given trip                                                                         | Persist a snapshot — Phase 11's job                                                                                                                                                                                                                                        |
| `get_currency_rate`     | Live rate via the resilient, dual-vendor Currency provider                                                                                                      | —                                                                                                                                                                                                                                                                          |
| `search_destination`    | Web search via Zenserp, returns titles/URLs/snippets                                                                                                            | Present results as verified fact without a source — that discipline belongs to Phase 13's Research Agent when it composes an answer from this tool's output                                                                                                                |
| `search_trip_knowledge` | Honestly reports whether documents exist and whether any have finished processing                                                                               | Any actual retrieval — there is no embedding pipeline yet (Phase 15). Returns `{status: "no_documents"}` or `{status: "not_yet_processed"}`, never a fabricated match                                                                                                      |
| `calculate_budget`      | A real, deterministic currency conversion (the multiplication happens in code, never asked of the model)                                                        | Estimate a full trip cost from market prices. Phase 20 deliberately still doesn't: costs are the traveler's recorded input (there is no flight/hotel/activity price feed), and budget validation sums those real numbers instead of inventing any                          |
| `create_recommendation` | Persists a real row matching Phase 17's four-part structure (Decision/Evidence/Reasoning/Recommendation) with a bounds-checked confidence                       | Generate the recommendation's content itself — an agent (Phase 9+) decides what to say; this tool only validates and persists it                                                                                                                                           |
| `get_trip_risk`         | The stored deterministic assessment (score, severity, factors, confidence)                                                                                      | Computing a score — Phase 16 owns that, and this only reads it                                                                                                                                                                                                             |
| `get_trip_risk_history` | Past assessments for the same trip                                                                                                                              | —                                                                                                                                                                                                                                                                          |
| `get_trip_itinerary`    | The trip's stored day-by-day items plus the **deterministic** budget status (per-currency totals, cap, converted total, or an explicit reason it's unavailable) | Writing anything. The planner proposes; the caller persists after grounding (Phase 20)                                                                                                                                                                                     |
| `create_alert`          | Persists exactly one notification when called                                                                                                                   | Any throttling or dedup. The automated paths now have both (Phase 18 dedupe key, Phase 19 scheduling), but this tool still writes directly through `createNotification`, so an agent calling it repeatedly would bypass that gate — a known footgun, not a documented mock |

Every tool is trip-scoped (takes a `tripId`, checks ownership) for a
uniform authorization model, even `get_currency_rate` and `calculate_budget`,
where the underlying data isn't inherently private — consistency across all
13 tools matters more here than optimizing away an ownership check on the
two where it's technically not required for privacy.

### The Planning Agent gets no write tool (Phase 20)

It is the only agent whose output is _persisted_ rather than returned, so
it is also the one with the narrowest tool set: five reads. Everything it
could ever do to the database goes through `groundPlanItems()` →
`replaceGeneratedPlan()` in its caller, after the output has been checked
against the trip's real dates and destinations. Persistence-by-tool in
the middle of reasoning would mean a half-validated plan already in the
table when the check failed.

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
operation — no `userId`, no authorization — because Trip Watch
(Phase 19's `runDueWatches()`) calls this directly while iterating over
monitored flights, not on behalf of one user's request.
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

## The Currency Agent (Phase 12)

`src/ai/agents/currency-agent.ts` is deliberately lighter than the
Flight and Weather agents. Re-reading this phase's own brief text —
retrieval, normalization, conversion, timestamped snapshots, caching —
it does not list "detect significant changes" or "compare against
previous snapshot" the way Phases 10 and 11 explicitly do. That's
respected as a considered scope difference, not an oversight: an
ordinary currency-rate fluctuation isn't actionable for a traveler the
way a flight cancellation or severe weather is. If currency volatility
ever needs to be a first-class alert, it fits naturally as one more
factor in Phase 16's Risk Engine rather than being retrofitted here.

Retrieval, normalization, caching, and the resilient dual-vendor
fallback all already existed end-to-end from Phase 5/6. What this phase
actually added: a single cohesive call
(`getExchangeRateSnapshot`/`runCurrencyAgentForUser`) that fetches the
rate **and** records the timestamped snapshot together — previously two
separate, unconnected calls a caller had to remember to make both of —
plus `convertCurrencyAmount()`, a shared, tested conversion utility that
replaced an inline duplicate multiplication in the `calculate_budget`
tool (Phase 8), so the rounding behavior can't quietly drift between the
two if either is ever changed independently.

**Every snapshot is recorded**, with no significance gate — consistent
with this phase's simpler scope. Two identical consecutive checks
produce two rows and two events, not one, unlike the Flight and Weather
agents' deliberate deduplication.

Verified live with a level of confidence the other two agents' live
tests couldn't reach on their own: both real vendor credentials are
configured, so a real end-to-end run exercised the **entire** dual-vendor
fallback chain — Fixer attempted and correctly failed fast on a
non-retryable 403, immediate failover to ExchangeRate, which also
correctly failed fast the same way, both outcomes visible in the actual
structured logs, ending in one clean `PROVIDER_ERROR` rather than two
separate unhandled failures.

## The Research Agent (Phase 13)

`src/ai/agents/research-agent.ts` is the first of the specialized agents
that genuinely belongs in Phase 9's LLM orchestrator, not a plain
TypeScript service. Re-reading its actual job — "summarize only
retrieved information" — that's a synthesis task with no deterministic
formula behind it, unlike Phases 10–12.

### The system prompt is the actual enforcement mechanism

There's no code-level check that can verify an LLM's answer only used
retrieved facts rather than its training data — so "never present
search-generated information as verified fact without evidence" and
"summarize only retrieved information" are enforced by stating the
constraint as forcefully and specifically as possible in the agent's
role, not by a validator downstream. What _is_ code-enforced:
`hasEvidence` is a required boolean the model must commit to, and a
defense-in-depth check in `runResearchAgentForUser` outright rejects any
answer that claims `hasEvidence: true` while citing zero sources —
an internally inconsistent answer isn't passed along to the traveler
just because it validated against the output schema's types.

### Authorization runs twice, deliberately

`search_destination` already re-verifies trip ownership on every call
(Phase 8, using the real injected `userId`, never the model's `tripId`
input). `runResearchAgentForUser` checks ownership _again_, up front,
before spending an LLM call at all. This isn't redundant: without the
upfront check, an unauthorized request wouldn't fail cleanly — it would
only surface as a confusing `NOT_FOUND` tool-result buried inside the
orchestration loop, likely still producing _some_ apologetic final
answer rather than a clean, immediate rejection. Verified directly: a
non-owner's request is confirmed rejected with the Anthropic mock never
being called at all.

### Efficient context, not a wasted tool call

The trip's destinations are pre-fetched and included directly in the
question sent to the model, rather than requiring the model to spend a
tool call on `get_trip` just to learn where the trip is going — `get_trip`
remains available if it wants more detail (dates, traveler count), but
the common case doesn't need to ask for it.

### Verification status

Same situation as the orchestrator itself (Phase 9): no real
`ANTHROPIC_API_KEY` in this sandbox. Every test mocks the Anthropic API
boundary; the search tool, trip authorization, and Postgres underneath
are genuinely real. Live verification went further than Phase 9 could,
though: with no real key configured at all, the actual `@anthropic-ai/sdk`
client throws a specific, real error — "Could not resolve authentication
method" — _before_ attempting any network call. That propagated
correctly through the orchestrator's own error handling as `API_ERROR`,
through `runResearchAgentForUser` as a clean `ProviderError`, out tothe client as a structured `502` with the full stack trace confined to
the server log only — the Phase 2 "never leak internals" principle holding
all the way through the deepest pipeline built so far.

## The Planning Agent (Phase 20)

`src/ai/agents/planning-agent.ts` is the seventh and last specialized
agent, and the third that runs in Phase 9's orchestrator. Composing a
day-by-day schedule from a trip's real dates, destinations, weather,
search results, and uploaded documents is synthesis — but it is also the
one agent whose output is **written to the database**, which is exactly
why it has the narrowest tool set (five reads, no write tool at all) and
the most code-level checks around it.

### Three enforced invariants

1. **No cost fields exist in its output schema.** Not "don't write a
   price" in a prompt — there is no key for one to be written to. A test
   asserts `z.toJSONSchema(planningAgent.outputSchema)` contains no
   `cost`/`price`/`currency` token. Costs are the traveler's own input,
   validated deterministically by `budget-service.ts`.
2. **Every day and every city is checked before anything persists.**
   `groundPlanItems()` validates against the trip's stored dates and its
   real destination rows; an unknown city, an out-of-range date, a
   duplicated day, or an item that ends before it starts rejects the
   whole plan with a specific message. Half a plan is not a plan.
3. **Persistence is the caller's job.** The wrapper (`runPlanningAgentForUser`)
   grounds first, then calls `replaceGeneratedPlan()`, which swaps the
   trip's AI-generated rows in one transaction and leaves traveler-entered
   items alone.

### Authorization runs before the model does

Same pattern as the Research and Risk agents: ownership is checked up
front, and the trip's dates and destinations are pre-fetched into the
request message so the model doesn't spend one of its 8 tool-call budget
learning where the trip goes. A trip with no dates or no destinations is
refused _before_ an LLM call, with a message saying what to set.

### Verification status

No `ANTHROPIC_API_KEY` exists in this sandbox (11 other provider keys
were supplied and wired in Phase 20; Anthropic was not among them), so —
like Phases 9/13/17 — every test mocks only the Anthropic boundary while
the grounding, authorization, registry, and Postgres underneath are
genuinely real. What Phase 20 could verify live, it did: the refusal
path returns a structured `502 PROVIDER_ERROR` naming the missing key
(observed against the running preview), and the deterministic half of
the feature (manual items, day-range validation, real FX budget
validation) ran end to end against real providers.

## The Command Agent (Phase 22)

`src/ai/agents/command-agent.ts` is the eighth agent and the first
_generalist_: the 7 specialized agents each answer their own kind of
question, while the Command Agent takes one free-text command from the
trip page's command bar and answers it with whatever read tools it
needs. It is the concrete implementation of the request flow
`docs/ARCHITECTURE.md` Section 8 has described since Phase 1
(`POST /api/trips/[id]/ask` → orchestrator → tool layer → answer with
evidence).

### The read-only invariant

Its `allowedTools` are exactly the registry's 11 read tools. The two
action tools — `create_recommendation` and `create_alert` — are absent,
and `command-agent.test.ts` asserts that, the same way Phase 20's test
asserts the planner's output schema has no cost field. A traveler's
question must never mutate the trip as a side effect of being asked; if
the command implies an action, the answer recommends it and the traveler
does it through the UI's real forms.

### Evidence with real provenance, checked in code

The answer's `evidence[]` entries must each name a tool **that was
actually invoked in that run**. That check needed one new thing from the
orchestrator: `runAgent` now records `toolCalls: OrchestratorToolCall[]`
(name + success, in order) on both result branches — the first change to
`orchestrator.ts` since Phase 9, purely additive, and the 9 existing
orchestrator tests still pass. `assertEvidenceWasInvoked()` then rejects
any answer citing a tool absent from that log with a `ValidationError`
listing the offending sources. This is the same discipline as Phase 17's
`assertGroundedInFactors`: the prompt requests grounded evidence, and
code enforces it against a record the model cannot author.

A subtlety worth keeping: an invoked-but-_failed_ call still counts as
grounded. "The weather provider returned an error" is an honest,
checkable statement about a real invocation — the call log carries the
failure and the UI renders it as a ✗ — so requiring success would reject
the most honest answers instead of the fabricated ones.

### The same honest-refusal policy, once more

Without `ANTHROPIC_API_KEY` the command bar refuses with a
`ProviderError` naming the key before any model call, and the trip page
renders the bar disabled with that explanation. It is the fourth
LLM-backed feature to refuse rather than fake (after risk explanations,
research, and planning); the difference here is only that the refusal is
also surfaced in the UI at first glance, because the command bar sits at
the top of the trip page.

### Verification status

Identical situation to Phases 9/13/17/20: no Anthropic key in this
workspace, so tests mock only the Anthropic boundary. Everything the
sandbox can verify for real was verified: the full pipeline test runs
real tools against real Postgres (a real `get_trip` call appears in the
real call log), the fabricated-provenance rejection is exercised with a
real schema-valid answer, and the live refusal path returns the
structured `502` observed against the running preview. The happy path
(an actual model composing an answer over live provider data) remains
unverifiable here and is documented as such, not simulated.
