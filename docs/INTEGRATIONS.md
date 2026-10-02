# TripOS — External API Integrations

## Status: Phase 5 (External API Integration Layer) Complete

## The pattern

Every external capability is one TypeScript interface with (at least) two
implementations: a real adapter that calls the actual vendor API, and a
documented mock adapter for when no credential is configured. A factory
per domain picks between them based on `src/config/env.ts`'s
`providerAvailability`. Nothing outside `src/integrations/*` ever imports
a vendor SDK or builds a vendor-specific URL — the domain layer (and
later, the AI tool layer) only ever sees the normalized interface.

```text
ExternalProvider (marker interface: providerName)
   ↓
AviationProvider    → AviationstackProvider (real) | MockAviationProvider
WeatherProvider     → WeatherstackProvider (real)  | MockWeatherProvider
CurrencyProvider    → FixerCurrencyProvider (real) | ExchangeRateCurrencyProvider (real) | MockCurrencyProvider
SearchProvider      → ZenserpProvider (real)       | MockSearchProvider
DocumentStorageProvider → FilestackProvider (real) | MockDocumentStorageProvider
GeolocationProvider → IpstackProvider (real)       | MockGeolocationProvider
PhoneValidationProvider → NumverifyProvider (real) | MockPhoneValidationProvider
EmailValidationProvider → MailboxlayerProvider (real) | MockEmailValidationProvider
```

`CurrencyProvider` deliberately has **two independent real
implementations** — this is what proves the abstraction is genuine rather
than a single vendor wrapped in an unnecessary interface. Choosing between
them as a resilience _fallback_ (try Fixer, fall back to ExchangeRate on
failure) is explicitly Phase 6's job, not this layer's — see "What this
phase does not do" below.

## Verification methodology (important)

Every adapter is tested by stubbing `fetch` to return a **realistic
fixture** and asserting the adapter normalizes it correctly, handles the
vendor's actual error shape, and rejects malformed responses — real
tests of real parsing logic.

**How the fixtures were sourced, in two stages:** for Phase 5 they came
from cross-checking dated public sources, because vendor domains were
then unreachable from the build sandbox. **On 2026-10-02 the real
credentials were wired in and every provider was called live** — which
found two adapter bugs the doc review had missed (both fixtures were
faithful to the _documented_ API and wrong about the _actual_ one). The
fixtures below have since been replaced with verbatim live responses,
and the endpoints that matter are pinned by regression tests.

Per-provider, current status:

| Provider                         | Confidence                                                     | Basis                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aviationstack                    | **Live-verified 2026-10-02** (plus doc cross-check 2026-08-27) | Real `GET /v1/flights?flight_iata=ET602` returned HTTP 200 with the documented fields (`flight_status`, `departure.terminal`, …) — the shape already matched the adapter                                                                                                                                                                                                                      |
| Weatherstack                     | **Live-verified 2026-10-02** (plus doc cross-check 2026-08-27) | A real snapshot recorded through the app (24 °C, Overcast, 4 kph). Doc review had surfaced its quirk: HTTP 200 even for API-level errors, checked in the body with a dedicated test                                                                                                                                                                                                           |
| Fixer / ExchangeRate             | **Live-verified 2026-10-02 — the earlier claim was wrong**     | The APILayer gateway form the adapter used returns **401** for this project's Fixer key; `data.fixer.io/api/latest?access_key=` returns **200** with real rates. `EXCHANGERATE_API_KEY` is a **CurrencyLayer** credential: `api.currencylayer.com/live` 200, `exchangerates_data` 401, exchangerate-api v6 `invalid-key`. Both adapters re-pointed; both endpoints pinned by regression tests |
| Zenserp                          | **Live-verified 2026-10-02**                                   | Real `GET /api/v2/search` returned `organic[]` with `{position, title, url, description}` — the shape the adapter expected, now observed rather than assumed                                                                                                                                                                                                                                  |
| Filestack                        | **Live-verified 2026-10-02 — earlier assumption was wrong**    | A real `POST /api/store/S3` stored the bytes and returned `{url, size, type, filename}` with **no `handle` field**, which the first adapter required — every real upload would have been rejected as malformed even though it succeeded. `storageKey` now derives from the URL's handle segment; the fixture is the verbatim live response                                                    |
| IPstack, Numverify, Mailboxlayer | **Live-verified 2026-10-02**                                   | Direct probes returned HTTP 200 with documented payloads; Mailboxlayer's real response is what the registration flow already consumes (`format_valid`)                                                                                                                                                                                                                                        |
| Marketstack                      | **No adapter, by design**                                      | `MARKETSTACK_API_KEY` is deliberately unmapped to any feature (see `.env.example`) — wiring it up "because it's available" would be a dependency without a justification                                                                                                                                                                                                                      |
| Screenshotlayer                  | **No adapter**                                                 | An availability flag exists in `src/config/env.ts`, but no TripOS feature needs page screenshots, so no adapter was written                                                                                                                                                                                                                                                                   |

## Resilience (Phase 6)

Every real adapter for Aviation, Weather, and Currency is now wrapped by
`infrastructure/resilience.ts`, implementing the exact flow from
`docs/ARCHITECTURE.md`: cache check → provider call with retry+backoff →
fallback provider → degraded mode via stale cache. Callers never see this
— `getAviationProvider()` etc. return the wrapped version transparently,
so a future agent just calls `.getFlightStatus()` normally.

```text
REQUEST → CACHE CHECK → fresh hit? return
                       → miss/stale → CIRCUIT OPEN? fail fast
                                    → PROVIDER (retry + backoff, only on
                                      retryable errors: 5xx/429/network,
                                      never 4xx like a bad key)
                                    → success? cache + return
                                    → still failing → FALLBACK provider
                                      (if one exists) → success? cache + return
                                                      → also failing →
                                        stale cache exists? DEGRADED
                                        MODE (return it, marked stale)
                                                      → nothing left →
                                        clear ProviderError
```

**Currency finally gets its real fallback**: when both `FIXER_API_KEY`
and `EXCHANGERATE_API_KEY` are configured, `getCurrencyProvider()` returns
a provider that tries Fixer, retries it on transient failures, and
genuinely fails over to ExchangeRate — a different vendor, not a retry of
the same one — if Fixer is still down. Verified two ways: a mocked-fetch
test proving the composition logic, and a live run against the real
(sandbox-unreachable) credentials showing the whole chain — primary
fails, correctly skips retrying a non-retryable 403, falls to secondary,
also correctly fails fast, clear error surfaces — completing in **170ms**.

**Circuit breaker**: in-memory per provider (deliberately not
Redis-backed — this runs as a single instance; sharing state across
multiple instances would need Redis, but there's no evidence that's
needed yet). Opens after 5 consecutive failures, cooldown 30s, then
allows one half-open trial before fully closing or re-opening.

**Every attempt updates `api_health`** (Phase 3's table, previously
unused) via `modules/observability/api-health-repository.ts` —
DEGRADED at 1–2 consecutive failures, DOWN at 3+, back to OPERATIONAL on
any success. This is what lets Phase 23's observability panel show real
per-provider status instead of an invented "all operational."

### A real bug found by testing against Postgres, not by inspection

The `api_health` upsert initially wrote unquoted string literals
(`'DEGRADED'`) into an enum column inside a query combining `ON CONFLICT
... DO UPDATE` with a `CASE` expression. Postgres's type inference failed
on that combination — a genuine runtime SQL type error
(`column "status" is of type "ApiHealthStatus" but expression is of type
text`) that TypeScript could never catch, since it's a raw SQL string.
Found by testing directly against real Postgres, fixed with explicit
`::"ApiHealthStatus"` casts. Every future repository touching an enum
column (Trip, Flight, Document, Risk, Recommendation all have one) should
cast explicitly from the start — noted in `AGENTS.md` so it isn't
rediscovered per-phase.

### A real infrastructure hardening found during manual verification

While manually verifying the currency fallback live, a call hung well
past its expected sub-second duration. Root cause: Redis was
unreachable (this sandbox doesn't persist background services between
tool invocations — see `docs/BUILD_PROGRESS.md`), and `ioredis`'s default
reconnection behavior doesn't fail fast when the server is genuinely
unreachable, as opposed to reachable-but-erroring. That's a problem
independent of this sandbox: `resilience.ts`'s cache functions are
written to treat Redis failures as non-fatal ("cache is an optimization,
never a hard dependency"), but a slow-to-reject promise defeats that
intent even though it's eventually caught correctly. Fixed with an
explicit `connectTimeout` and a capped `retryStrategy` on the shared
Redis client (`infrastructure/redis.ts`), verified with a dedicated test
against a genuinely unreachable address (fails in ~600ms now, not 30+
seconds).

## Deliberately not built

- **Screenshotlayer** — the brief is explicit: "use only when there is a
  legitimate product feature requiring webpage screenshots." No such
  feature exists yet. Building an adapter with nothing to call it would
  be exactly the kind of unjustified dependency the brief warns against.
- **Marketstack** — stock market data has no identified role in a travel
  platform. Credential is available (see `docs/BUILD_PROGRESS.md`) but
  unused, same reasoning as Screenshotlayer.

## Closing the loop from Phase 4

`docs/SECURITY.md`'s "known gaps" listed email-deliverability validation
at registration as deferred specifically until this layer existed.
`app/api/auth/register/route.ts` now calls
`getEmailValidationProvider().validateEmail()` — **failing open**: if the
provider errors, times out, or isn't configured, registration proceeds
anyway. Verified live, not just in a unit test: with a real (but
sandbox-unreachable) `MAILBOXLAYER_API_KEY` configured, a real
registration request still succeeded end-to-end, because the real
adapter's genuinely-failing network call was caught and swallowed exactly
as designed — the same fail-open principle already applied to
`rate-limit.ts`'s Redis-unreachable case.

## What this phase does not do

Deferred on purpose, to the phases that own them:

- Retry, backoff, circuit breaking, response caching → Phase 6
- The Fixer→ExchangeRate resilience _fallback_ specifically → Phase 6
- Actually wiring these into the seven specialized agents → Phases 10–13
- The real upload pipeline calling `DocumentStorageProvider` → Phase 14
