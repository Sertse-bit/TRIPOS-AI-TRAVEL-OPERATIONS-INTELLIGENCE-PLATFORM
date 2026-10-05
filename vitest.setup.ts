// Minimal required environment for tests. Kept intentionally separate
// from .env.local so test runs never depend on real secrets.
// NODE_ENV is already "test" by default under Vitest — it's typed
// read-only, so we don't (and shouldn't need to) assign it here.
//
// These assignments are UNCONDITIONAL, deliberately not `??=`.
// Vitest loads .env.local into process.env, so `??=` let a workspace
// that has real credentials run the whole suite against the DEVELOPMENT
// database and with REAL provider keys — discovered in Phase 23, when
// the observability panel displayed `test-provider-*` health rows the
// resilience tests had written into dev, plus a real `weatherstack` row
// from a test that quietly stopped hitting its fetch stub once a real
// key existed. Tests must be hermetic: the values below are the only
// ones the suite ever sees. CI (or anyone) can point the suite at a
// different test database with TEST_DATABASE_URL.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:devpassword@localhost:5432/tripos_test";
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";
process.env.AUTH_SECRET = "test-secret-at-least-32-characters-long-000";

// Fake (non-functional) provider keys so real-adapter tests can exercise
// their request-building and parsing logic via mocked fetch — see e.g.
// integrations/aviation/provider.test.ts — without the "is a key even
// configured" guard clause short-circuiting before the mock is reached.
// Every provider test stubs `fetch`; these values are never used for a
// real network call.
process.env.AVIATIONSTACK_API_KEY = "test-key-aviationstack";
process.env.WEATHERSTACK_API_KEY = "test-key-weatherstack";
process.env.FIXER_API_KEY = "test-key-fixer";
process.env.EXCHANGERATE_API_KEY = "test-key-exchangerate";
process.env.IPSTACK_API_KEY = "test-key-ipstack";
process.env.NUMVERIFY_API_KEY = "test-key-numverify";
process.env.ZENSERP_API_KEY = "test-key-zenserp";
process.env.FILESTACK_API_KEY = "test-key-filestack";
process.env.MAILBOXLAYER_API_KEY = "test-key-mailboxlayer";
