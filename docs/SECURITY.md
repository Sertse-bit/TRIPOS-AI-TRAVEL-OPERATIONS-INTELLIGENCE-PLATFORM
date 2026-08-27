# TripOS — Security

## Status: Phase 4 (Authentication & Security Foundation) Complete

## Authentication

Credentials-based (email + password), not OAuth — see
`docs/ARCHITECTURE.md` Section 12 and its Phase 4 refinement in the
decisions log for why this is hand-rolled rather than built on the
`next-auth`/Auth.js library: the Phase 3 `sessions` table stores a _hash_
of the session token, not the raw value, which doesn't match Auth.js's
official Prisma adapter contract. Hand-rolling keeps the mechanism fully
inspectable rather than routing through library internals with a
partially-incompatible schema underneath.

### Password storage

`src/modules/auth/password.ts` — Node's built-in `scrypt`, not
bcrypt/argon2. OWASP lists scrypt as an acceptable KDF when Argon2id isn't
available, and Node's implementation needs no native addon (bcrypt/argon2
packages require `node-gyp` and can fail to build in constrained
environments — this project's own build sandbox among them). Parameters:
N=16384, r=8, p=1 (the "interactive" tier from the original scrypt paper),
which fits comfortably inside Node's default scrypt `maxmem`. Every hash
stores its own cost parameters inline, so they can be strengthened later
without invalidating already-stored hashes.

Password strength policy: minimum 12 characters, no mandatory composition
rules (no forced uppercase/digit/symbol). This follows NIST 800-63B
guidance directly — composition rules push people toward predictable,
low-entropy substitutions ("Password1!") without meaningfully increasing
real security, while length does.

### Sessions

`src/modules/auth/session.ts` — a cryptographically random 32-byte token
is generated per login, SHA-256-hashed, and only the hash is stored
(`sessions.token_hash`). SHA-256, not scrypt, is deliberate: a session
token is already high-entropy and random, unlike a human-chosen password,
so there's no brute-forceable low-entropy space to protect against —
using a slow KDF here would just add latency to every authenticated
request for no security benefit.

Sessions are database-backed rather than JWT specifically so they're
**immediately, server-side revocable** — `revokeAllUserSessions()` gives a
real "log out everywhere," which a stateless JWT can't do without an
additional blocklist (at which point it's arguably not stateless anyway).
Cookie is `httpOnly`, `sameSite: lax`, `secure` in production, 30-day
expiry.

## Authorization

`src/modules/auth/access-control.ts` provides two primitives:
`requireAuth()` (authentication) and `requireRole()` (role-based
authorization, e.g. for a future admin-only route). **Resource-level
(row) authorization — "does this user own this trip" — is deliberately
not built yet**, since no resource-owning routes exist until Phase 7's
Trip Service. It will use this same `AppError`/`UnauthorizedError`
pattern when it lands, not a separate mechanism.

## Rate limiting

`src/infrastructure/rate-limit.ts` — Redis-backed fixed-window counters.
Login is limited by **both** IP and email (20/hour and 8/hour
respectively): IP-only limiting lets an attacker spread guesses across
many accounts from one IP without tripping anything; email-only limiting
lets a botnet distribute guesses against one account across many IPs.
Together they close both gaps.

**Deliberate fail-open behavior**: if Redis itself is unreachable, rate
limiting is skipped rather than blocking the request. An auth endpoint
should degrade to "temporarily unlimited" rather than "no one can log in"
if the cache layer goes down — a fail-closed rate limiter turns a Redis
outage into a full authentication outage, which is a worse failure mode
for most products than a temporary loss of brute-force protection.

## CORS

No cross-origin allowlist is configured. The frontend and API are served
from the same Next.js app on the same origin, so the browser's default
same-origin policy already blocks cross-origin access to these endpoints
— an explicit CORS policy would only be needed if a separate origin
(a mobile app calling the API directly, a future public API surface)
needs access, at which point an explicit, narrow allowlist should be
added rather than a wildcard.

## CSRF

Not implemented as a separate token scheme. Mitigated instead by
`SameSite=Lax` cookies (blocks cross-site `fetch`/XHR from sending the
session cookie) combined with every mutating endpoint being a JSON API,
not a form-encoded one (a cross-site `<form>` POST can't set a JSON
`Content-Type` without a preflight, which a foreign origin can't satisfy).
**This combination stops working** if a traditional HTML form-based
mutation is ever added, or if a route ever needs `SameSite=None` for
cross-origin embedding — either of those should come with a real CSRF
token at the same time.

## Secure headers

Set globally in `next.config.ts`: `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
a restrictive `Permissions-Policy`, and a `Content-Security-Policy`. The
CSP currently allows `'unsafe-eval'` in `script-src` because Next.js dev
mode's hot-module-reload needs it — production builds don't, and this
should be tightened once there's a real production build to verify
against (Phase 30). Phase 21 (frontend) and Phase 26 (WebGL effect) may
need to widen specific directives further; if so, widen the specific
directive and document why here, not the policy broadly.

## File upload validation

`src/shared/file-validation.ts` — validates by sniffing actual file
content (magic bytes via the `file-type` library), not by trusting the
client-supplied filename or `Content-Type` header, both of which are
trivially spoofable. Rejects: empty files, files over 10MB, content whose
real type isn't in the allowlist (PDF/JPEG/PNG) even when a type _is_
successfully detected, and any mismatch between the declared and detected
type. This is the reusable primitive; the actual upload route belongs to
Phase 14 (Document Intelligence) and will call this rather than
re-implementing validation.

## API key / secret protection

- All external provider keys and infrastructure secrets are read
  exclusively through `src/config/env.ts`, which is never imported by
  client components and never re-exports anything under a
  `NEXT_PUBLIC_` name.
- This is enforced by an automated test
  (`src/config/env-safety.test.ts`), not just documentation: it fails the
  suite if any `NEXT_PUBLIC_`-prefixed, secret-shaped variable ever
  appears anywhere in `src/`, and if `.env.example` ever gets a real
  value pasted into it instead of staying empty.
- Real secrets live only in `.env.local`, which is git-ignored (verified
  before every commit throughout this build via `git status`/
  `git diff --cached`, not just assumed).

## Known gaps (honest, not hidden)

- No email verification or password-reset flow yet. Mailboxlayer
  (available, see `docs/BUILD_PROGRESS.md`) is a natural fit for
  validating email deliverability at registration — deliberately not
  wired in yet, since that would mean calling an external provider
  directly from the auth module before Phase 5 establishes the general
  provider-abstraction pattern. Revisit once Phase 5 lands.
- No 2FA.
- No account lockout beyond rate limiting (a sufficiently patient,
  distributed attacker can still make slow progress within the rate
  limits — acceptable for a portfolio project's threat model, worth
  revisiting for anything handling real user data).
- `travelers.passport_number` (Phase 3 schema) is stored as plain text.
  Flagged there and again here: needs encryption-at-rest and access
  auditing before this schema should hold real passport data.
- No DB-level `CHECK` constraints on `risk_score`/`confidence` ranges yet
  (application-level validation only) — tracked in `docs/DATABASE.md`.
- **Credential hygiene reminder**: the GitHub PAT and all 11 external API
  keys used during this build were shared directly in the chat that built
  it, not through a secrets manager. They should be rotated once this
  build session is done, independent of anything above.
