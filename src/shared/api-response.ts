import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError, isAppError } from "@/shared/errors";
import { createRequestLogger, logger } from "@/infrastructure/logger";

export function generateRequestId(): string {
  return `req_${randomUUID()}`;
}

interface SuccessEnvelope<T> {
  data: T;
  requestId: string;
}

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

export function successResponse<T>(data: T, requestId: string, status = 200) {
  const body: SuccessEnvelope<T> = { data, requestId };
  return NextResponse.json(body, { status, headers: { "x-request-id": requestId } });
}

function errorResponse(
  code: string,
  message: string,
  requestId: string,
  status: number,
  details?: unknown,
) {
  const body: ErrorEnvelope = { error: { code, message, requestId, details } };
  return NextResponse.json(body, { status, headers: { "x-request-id": requestId } });
}

/**
 * Wraps a Next.js route handler so every response — success or failure —
 * goes through the same envelope, gets a request ID, and gets logged.
 *
 * Handlers can just `throw new AppError(...)` (or a subclass) for any
 * expected failure. Anything else thrown is treated as a bug: logged with
 * full detail server-side, but the client only ever sees a generic 500 —
 * no stack traces, no internal messages leak out (Section 11).
 *
 * The wrapped function's parameter is always typed as NextRequest — that
 * matches what Next.js actually invokes every route handler with,
 * regardless of whether a given handler needs it. Handlers that don't
 * (see app/api/health/route.ts) simply declare fewer parameters and
 * ignore it; that's a normal, safely-typed JS/TS pattern, not a hack.
 * An earlier version made the request type generic and defaulted it to
 * `undefined` when unspecified, which broke Next's own route-type
 * validator (`.next/types/validator.ts`) for any handler that didn't
 * explicitly parameterize it — caught by `pnpm typecheck`, not by
 * inspection.
 */
export function withApiHandler<T>(
  handler: (
    requestId: string,
    log: ReturnType<typeof createRequestLogger>,
    request: NextRequest,
  ) => Promise<T>,
) {
  return async function wrapped(request: NextRequest) {
    const requestId = generateRequestId();
    const log = createRequestLogger(requestId);

    try {
      const result = await handler(requestId, log, request);
      return successResponse(result, requestId);
    } catch (error) {
      if (isAppError(error)) {
        log.warn({ code: error.code, err: error }, "Handled application error");
        return errorResponse(error.code, error.message, requestId, error.httpStatus, error.details);
      }

      if (error instanceof ZodError) {
        log.warn({ issues: error.issues }, "Request validation failed");
        return errorResponse(
          "VALIDATION_ERROR",
          "Request validation failed.",
          requestId,
          400,
          error.issues,
        );
      }

      // Unexpected error: full detail goes to the server log only.
      log.error({ err: error }, "Unhandled error in route handler");
      logger.error({ requestId, err: error }, "Unhandled error (top-level)");
      return errorResponse("INTERNAL_ERROR", "Something went wrong.", requestId, 500);
    }
  };
}

// Re-export so route files have a single import for the common case.
export { AppError };
