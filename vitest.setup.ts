// Minimal required environment for tests. Kept intentionally separate
// from .env.local so test runs never depend on real secrets.
// NODE_ENV is already "test" by default under Vitest — it's typed
// read-only, so we don't (and shouldn't need to) assign it here.
process.env.DATABASE_URL ??= "postgresql://postgres:devpassword@localhost:5432/tripos_test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.AUTH_SECRET ??= "test-secret-at-least-32-characters-long-000";
