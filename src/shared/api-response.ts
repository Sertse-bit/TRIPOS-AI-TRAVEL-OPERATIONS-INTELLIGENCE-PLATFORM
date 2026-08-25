import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
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
 */
export function withApiHandler<T>(
  handler: (requestId: string, log: ReturnType<typeof createRequestLogger>) => Promise<T>,
) {
  return async function wrapped() {
    const requestId = generateRequestId();
    const log = createRequestLogger(requestId);

    try {
      const result = await handler(requestId, log);
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
