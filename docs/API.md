# TripOS — HTTP API

The complete surface every route handler exposes, derived from the code
rather than from a design document.

**This table is enforced by a test** (`src/app/api-route-table.test.ts`):
it walks `src/app/api/**/route.ts`, reads the exported methods from each
file, and fails if the table here is missing a route, lists one that no
longer exists, or names the wrong methods. Adding or renaming a route
without updating this document breaks the build, so the document cannot
drift away from the API.

## The envelope

Every `/api` route is wrapped by `withApiHandler`
(`src/shared/api-response.ts`), so success and failure have one shape
everywhere. A request id (`req_<uuid>`) is in the body, in the
`x-request-id` response header, and in the server's log line for the same
request — one id, three places.

```jsonc
// success — HTTP 200
{ "data": { "user": { "id": "…", "email": "…" } }, "requestId": "req_5a0f936f-…" }

// failure — status depends on the error class
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "requestId": "req_5a0f936f-…",
    "details": [ /* zod issues, present for validation failures only */ ]
  }
}
```

## Error codes

| Code               | HTTP | Raised when                                                                                                                                                                                             |
| ------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR` | 400  | Request body/query fails its zod schema, or the service rejects the input (e.g. a budget amount without a currency). `details` carries the zod issues.                                                  |
| `UNAUTHENTICATED`  | 401  | No valid session — anonymous, expired, or the account no longer exists. A **database outage is not this**: it propagates as a 500 instead of telling a signed-in user their session expired.            |
| `UNAUTHORIZED`     | 403  | The session is valid but the role gate refuses.                                                                                                                                                         |
| `NOT_FOUND`        | 404  | The resource doesn't exist **or** belongs to someone else. A stranger's trip is deliberately indistinguishable from a nonexistent one, so ids can't be probed for existence.                            |
| `CONFLICT`         | 409  | Uniqueness violated (registering an email that already exists).                                                                                                                                         |
| `RATE_LIMITED`     | 429  | A rate-limit bucket is exhausted (see below).                                                                                                                                                           |
| `PROVIDER_ERROR`   | 502  | A third-party provider failed after retries and fallbacks were exhausted — including the LLM endpoints when `ANTHROPIC_API_KEY` is not configured. **Never faked:** there is no synthetic success path. |
| `INTERNAL_ERROR`   | 500  | Something unexpected. The response message is always the generic `"Something went wrong."` — the detail goes to the server log under the same `requestId`, never into the response.                     |

## Authentication

- Session cookie `tripos_session` (httpOnly, SameSite=Lax, Secure in
  production), set by login/register; the sessions table stores only the
  SHA-256 of the token.
- Route handlers call `requireAuth()` themselves — there is no middleware
  catching this for them.
- Resource ownership is checked inside each service, and a trip you don't
  own answers `404`, not `403`.
- Pages use `requireSession(returnTo)` instead: an anonymous visitor is
  redirected to `/login?returnTo=<encoded path>` so the destination
  survives sign-in.

## Rate limits

| Route                     | Bucket    | Limit     |
| ------------------------- | --------- | --------- |
| `POST /api/auth/login`    | per IP    | 20 / hour |
| `POST /api/auth/login`    | per email | 8 / hour  |
| `POST /api/auth/register` | per IP    | 5 / hour  |

Backed by Redis; when Redis is unreachable the limiter fails **open**
rather than taking authentication down with it (documented in
`docs/SECURITY.md`).

## Routes

Auth column: `—` = public, `session` = a valid session is required.

| Method             | Path                                                         | Auth    | Purpose                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`              | `/api/health`                                                | —       | Liveness plus configured-provider report (key _presence_ only, never values).                                                                                                                                              |
| `POST`             | `/api/auth/register`                                         | —       | Create an account and open a session. Fails open on email-check provider trouble; refuses an address the provider called undeliverable.                                                                                    |
| `POST`             | `/api/auth/login`                                            | —       | Sign in (constant-time failure for unknown emails).                                                                                                                                                                        |
| `POST`             | `/api/auth/logout`                                           | —       | End the session.                                                                                                                                                                                                           |
| `GET`              | `/api/auth/me`                                               | session | The session's user, or 401.                                                                                                                                                                                                |
| `GET, POST`        | `/api/trips`                                                 | session | List / create trips.                                                                                                                                                                                                       |
| `GET, PATCH`       | `/api/trips/[id]`                                            | session | Trip detail / update.                                                                                                                                                                                                      |
| `PATCH`            | `/api/trips/[id]/status`                                     | session | Change trip status.                                                                                                                                                                                                        |
| `POST`             | `/api/trips/[id]/destinations`                               | session | Add a destination.                                                                                                                                                                                                         |
| `POST`             | `/api/trips/[id]/travelers`                                  | session | Add a traveler.                                                                                                                                                                                                            |
| `POST`             | `/api/trips/[id]/flights`                                    | session | Add a flight.                                                                                                                                                                                                              |
| `GET`              | `/api/trips/[id]/events`                                     | session | The trip's append-only event history.                                                                                                                                                                                      |
| `GET, PUT`         | `/api/trips/[id]/watch`                                      | session | Read / update Trip Watch settings.                                                                                                                                                                                         |
| `DELETE, PUT`      | `/api/trips/[id]/budget`                                     | session | Set / clear the trip budget.                                                                                                                                                                                               |
| `GET, POST`        | `/api/trips/[id]/itinerary`                                  | session | List / add itinerary items.                                                                                                                                                                                                |
| `DELETE, PATCH`    | `/api/trips/[id]/itinerary/[itemId]`                         | session | Edit / delete an itinerary item.                                                                                                                                                                                           |
| `POST`             | `/api/trips/[id]/itinerary/plan`                             | session | Planning agent (needs `ANTHROPIC_API_KEY`; no write tool, no cost field in its schema).                                                                                                                                    |
| `POST`             | `/api/trips/[id]/currency-check`                             | session | FX check for the budget, with each rate's timestamp.                                                                                                                                                                       |
| `GET, POST`        | `/api/trips/[id]/documents`                                  | session | List / upload documents (10 MB, content-sniffed).                                                                                                                                                                          |
| `POST`             | `/api/trips/[id]/documents/search`                           | session | Search an indexed document's chunks.                                                                                                                                                                                       |
| `POST`             | `/api/trips/[id]/documents/[documentId]/index`               | session | Chunk + embed a document.                                                                                                                                                                                                  |
| `POST`             | `/api/trips/[id]/flights/[flightId]/check-status`            | session | Live flight-status check, persisted.                                                                                                                                                                                       |
| `POST`             | `/api/trips/[id]/destinations/[destinationId]/check-weather` | session | Live weather check, persisted.                                                                                                                                                                                             |
| `POST`             | `/api/trips/[id]/monitor`                                    | session | Run one monitoring pass; failed checks are reported as skipped, never as "unchanged".                                                                                                                                      |
| `GET`              | `/api/trips/[id]/operational-state`                          | session | Deterministic operational state (no model involved).                                                                                                                                                                       |
| `GET, POST`        | `/api/trips/[id]/risk`                                       | session | Latest risk assessment / run one.                                                                                                                                                                                          |
| `GET, PATCH, POST` | `/api/trips/[id]/recommendations`                            | session | List / acknowledge-or-dismiss / generate an explanation.                                                                                                                                                                   |
| `POST`             | `/api/trips/[id]/research`                                   | session | Research agent (grounded in live search results).                                                                                                                                                                          |
| `POST`             | `/api/trips/[id]/ask`                                        | session | Command bar: read-only agent answer with a per-claim evidence trail and the real tool-call log.                                                                                                                            |
| `GET`              | `/api/trips/[id]/audit`                                      | session | One trip's audit trail, newest first.                                                                                                                                                                                      |
| `GET`              | `/api/audit`                                                 | session | The caller's own audit stream (account actions included).                                                                                                                                                                  |
| `GET, PATCH`       | `/api/notifications`                                         | session | List / mark notifications read (own rows only).                                                                                                                                                                            |
| `GET, POST`        | `/api/watches`                                               | session | List your watches / run the due-watch sweep (caller-scoped).                                                                                                                                                               |
| `GET`              | `/api/observability`                                         | session | Deployment health: live db/redis checks and per-provider records. **No role check exists** — any signed-in session can read it (`requireRole` is implemented but not wired to a route; recorded here rather than implied). |

## Outside `/api`

- 12 App Router pages under `src/app/**/page.tsx` are server-rendered and
  read through the same services; they are not part of this table.
- `POST /logout` (note: no `/api` prefix) is a form-post handler for
  server-rendered pages: it ends the session and answers `303` back to
  `/`, no JSON envelope. The JSON equivalent is `POST /api/auth/logout`.

## Example

```bash
curl -X POST https://example/api/trips \
  -H 'content-type: application/json' \
  -H 'cookie: tripos_session=…' \
  -d '{"title":"Lisbon, eventually"}'
```

```jsonc
// 200
{
  "data": { "trip": { "id": "…", "title": "Lisbon, eventually", "status": "PLANNING" } },
  "requestId": "req_5a0f936f-205e-46e3-803a-afc2b0624242",
}
```

The same `requestId` appears in the server log line for this request and,
for audited actions, on the `audit_logs` row that records it.
