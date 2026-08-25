import pino from "pino";
import { env } from "@/config/env";

/**
 * Structured logging. In development this pretty-prints to the terminal;
 * in production it emits JSON lines suitable for a log aggregator.
 *
 * Never log: raw provider API keys, session tokens, or password hashes.
 * Request-scoped loggers (via `.child()`) should carry a requestId so
 * every log line for one request can be correlated (see
 * shared/api-response.ts and docs/ARCHITECTURE.md Section 11).
 */
export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.NODE_ENV === "production" ? "info" : "debug",
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
      : undefined,
  redact: {
    paths: [
      "*.password",
      "*.passwordHash",
      "*.apiKey",
      "*.token",
      "*.authorization",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    censor: "[REDACTED]",
  },
});

export function createRequestLogger(requestId: string) {
  return logger.child({ requestId });
}
