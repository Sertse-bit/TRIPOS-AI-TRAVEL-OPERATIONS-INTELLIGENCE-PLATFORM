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

This sandbox's network egress doesn't reach any of these vendor domains —
the same constraint documented for Postgres/Redis's ecosystem tooling in
`docs/DATABASE.md`. So none of these adapters could be smoke-tested with
a live call. Instead, every adapter is tested by stubbing `fetch` to
return a **realistic fixture** and asserting the adapter normalizes it
correctly, handles the vendor's actual error shape, and rejects malformed
responses — real tests of real parsing logic, just without a live network
hop.

Per-provider, how confident that fixture is:

| Provider                         | Confidence                                             | Basis                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aviationstack                    | **Verified this session**                              | Cross-checked against 4+ independent, dated public sources (GitHub `apilayer/aviationstack` issue #5 showing real output, tutorialsteacher.com, dev.to, PHPZAG) as of 2026-08-27                                                                                                                                      |
| Weatherstack                     | **Verified this session**                              | Cross-checked against marketplace.apilayer.com, davidwalsh.name, tutorialsteacher.com as of 2026-08-27. Also surfaced a real quirk: Weatherstack returns HTTP 200 even for API-level errors — the error only appears in the response body shape, which the adapter checks explicitly (and which has a dedicated test) |
| Fixer / ExchangeRate             | **Verified this session**                              | Confirmed Fixer has migrated to APILayer's unified `api.apilayer.com/<product>` gateway with an `apikey` header, distinct from the legacy `data.fixer.io?access_key=` convention older tutorials show — the adapter uses the gateway form since this project's credential is an APILayer marketplace key              |
| Zenserp                          | Training knowledge only, **not verified this session** | Flagged in code comments — re-verify against zenserp.com's live docs before real use, with more scrutiny than the three above                                                                                                                                                                                         |
| Filestack                        | Training knowledge only, **not verified this session** | Filestack's real upload flow (multipart intelligent ingestion, webhooks) has more surface area than this simple version covers — treat as a starting point for Phase 14, not a finished integration                                                                                                                   |
| IPstack, Numverify, Mailboxlayer | Training knowledge only, **not verified this session** | Simple, stable, well-known APIs; lower risk than Filestack's more complex flow, but still unverified live                                                                                                                                                                                                             |

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
