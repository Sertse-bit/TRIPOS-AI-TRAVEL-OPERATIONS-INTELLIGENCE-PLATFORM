import { z } from "zod";

/**
 * Centralized environment configuration.
 *
 * Every environment variable the app depends on is declared here, once,
 * with a real validation rule. If something required is missing or
 * malformed, the app fails fast at startup with a clear message instead
 * of failing confusingly later inside a request handler.
 *
 * Nothing in this module is exposed to the browser. Do not import this
 * from client components — it is server-only by construction, and
 * defines no browser-exposed (Next.js public-prefixed) variables.
 */

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // --- Core infrastructure ---
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required").default("redis://localhost:6379"),

  // --- Auth ---
  AUTH_SECRET: z
    .string()
    .min(32, "AUTH_SECRET must be at least 32 characters (used to sign session data)"),

  // --- AI ---
  ANTHROPIC_API_KEY: z.string().min(1).optional(),

  // --- External providers (all optional at the schema level: the
  // integration layer decides per-provider whether to run in mock mode
  // when a key is absent — see docs/ARCHITECTURE.md Section 6/Phase 5) ---
  AVIATIONSTACK_API_KEY: z.string().optional(),
  WEATHERSTACK_API_KEY: z.string().optional(),
  FIXER_API_KEY: z.string().optional(),
  EXCHANGERATE_API_KEY: z.string().optional(),
  IPSTACK_API_KEY: z.string().optional(),
  NUMVERIFY_API_KEY: z.string().optional(),
  ZENSERP_API_KEY: z.string().optional(),
  FILESTACK_API_KEY: z.string().optional(),
  SCREENSHOTLAYER_API_KEY: z.string().optional(),
  MAILBOXLAYER_API_KEY: z.string().optional(),
  MARKETSTACK_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    // Fail loudly at startup. This is intentionally a hard crash: a
    // misconfigured environment should never limp along into runtime
    // errors that are harder to diagnose than a startup failure.
    console.error(`Invalid environment configuration:\n${issues}`);
    throw new Error("Environment validation failed. See errors above.");
  }

  return parsed.data;
}

export const env = loadEnv();

/**
 * Which external providers currently have a real credential configured.
 * Used by the integration layer (Phase 5) to decide real vs. mock adapter
 * per provider, and by the observability panel (Phase 23) to report
 * accurate status instead of inventing it.
 */
export const providerAvailability = {
  aviationstack: Boolean(env.AVIATIONSTACK_API_KEY),
  weatherstack: Boolean(env.WEATHERSTACK_API_KEY),
  fixer: Boolean(env.FIXER_API_KEY),
  exchangerate: Boolean(env.EXCHANGERATE_API_KEY),
  ipstack: Boolean(env.IPSTACK_API_KEY),
  numverify: Boolean(env.NUMVERIFY_API_KEY),
  zenserp: Boolean(env.ZENSERP_API_KEY),
  filestack: Boolean(env.FILESTACK_API_KEY),
  screenshotlayer: Boolean(env.SCREENSHOTLAYER_API_KEY),
  mailboxlayer: Boolean(env.MAILBOXLAYER_API_KEY),
} as const;
