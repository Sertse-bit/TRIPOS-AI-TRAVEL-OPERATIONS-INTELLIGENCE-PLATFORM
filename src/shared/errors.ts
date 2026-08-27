/**
 * Typed application errors.
 *
 * Every error that should ever reach an API response is one of these.
 * Anything else (an unexpected thrown error, a bug) is caught by the
 * route wrapper (see shared/api-response.ts) and converted to a generic
 * 500 without leaking internal detail to the client.
 *
 * See docs/ARCHITECTURE.md Section 11 for the error propagation policy
 * this implements.
 */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PROVIDER_ERROR"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  UNAUTHORIZED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PROVIDER_ERROR: 502,
  INTERNAL_ERROR: 500,
};

export interface AppErrorDetails {
  [key: string]: unknown;
}

/**
 * Base class for all expected, handled application errors.
 * Thrown deliberately by domain/service code — never for unexpected bugs.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: AppErrorDetails;

  constructor(code: ErrorCode, message: string, details?: AppErrorDetails) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = STATUS_BY_CODE[code];
    this.details = details;
    // No Object.setPrototypeOf() here: that pattern exists only to fix
    // `class extends Error` under pre-ES2015 transpilation targets. This
    // project targets ES2017 (tsconfig.json), where native class
    // extension already sets up the prototype chain correctly — and
    // calling it here would actively break things, resetting every
    // subclass's prototype back to AppError.prototype specifically and
    // making `instanceof SpecificSubclass` checks fail. Caught by a real
    // test (rate-limit.test.ts expecting instanceof RateLimitedError),
    // not by inspection.
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: AppErrorDetails) {
    super("VALIDATION_ERROR", message, details);
    this.name = "ValidationError";
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "Authentication required.") {
    super("UNAUTHENTICATED", message);
    this.name = "UnauthenticatedError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "You do not have access to this resource.") {
    super("UNAUTHORIZED", message);
    this.name = "UnauthorizedError";
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super("NOT_FOUND", id ? `${resource} not found: ${id}` : `${resource} not found.`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: AppErrorDetails) {
    super("CONFLICT", message, details);
    this.name = "ConflictError";
  }
}

/**
 * Raised by the integration layer (Phase 5/6) when a third-party provider
 * fails after retries/fallback are exhausted. Carries the provider name so
 * observability (Phase 23) can report real per-provider health instead of
 * a generic failure.
 */
export class ProviderError extends AppError {
  readonly provider: string;

  constructor(provider: string, message: string, details?: AppErrorDetails) {
    super("PROVIDER_ERROR", message, details);
    this.name = "ProviderError";
    this.provider = provider;
  }
}

export class RateLimitedError extends AppError {
  constructor(message = "Too many requests.") {
    super("RATE_LIMITED", message);
    this.name = "RateLimitedError";
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
