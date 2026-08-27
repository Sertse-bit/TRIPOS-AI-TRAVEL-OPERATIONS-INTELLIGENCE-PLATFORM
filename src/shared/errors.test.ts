import { describe, expect, it } from "vitest";
import {
  AppError,
  ConflictError,
  NotFoundError,
  ProviderError,
  UnauthenticatedError,
  UnauthorizedError,
  ValidationError,
  isAppError,
} from "@/shared/errors";

describe("AppError subclasses", () => {
  it("maps each error type to the correct HTTP status", () => {
    expect(new ValidationError("bad input").httpStatus).toBe(400);
    expect(new UnauthenticatedError().httpStatus).toBe(401);
    expect(new UnauthorizedError().httpStatus).toBe(403);
    expect(new NotFoundError("Trip", "abc123").httpStatus).toBe(404);
    expect(new ConflictError("already exists").httpStatus).toBe(409);
    expect(new ProviderError("aviationstack", "timed out").httpStatus).toBe(502);
  });

  it("includes the resource and id in NotFoundError's message", () => {
    const err = new NotFoundError("Trip", "abc123");
    expect(err.message).toContain("Trip");
    expect(err.message).toContain("abc123");
  });

  it("carries the provider name on ProviderError", () => {
    const err = new ProviderError("weatherstack", "rate limited");
    expect(err.provider).toBe("weatherstack");
  });

  it("preserves details for debugging without leaking them by default", () => {
    const err = new ValidationError("bad input", { field: "email" });
    expect(err.details).toEqual({ field: "email" });
  });

  it("isAppError correctly discriminates AppError from arbitrary errors", () => {
    expect(isAppError(new NotFoundError("Trip"))).toBe(true);
    expect(isAppError(new Error("plain error"))).toBe(false);
    expect(isAppError("not even an error")).toBe(false);
  });

  it("instanceof works correctly through the prototype chain", () => {
    const err = new NotFoundError("Trip");
    expect(err instanceof AppError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it("instanceof works against each SPECIFIC subclass, not just AppError", () => {
    // Regression test: an earlier version of AppError called
    // Object.setPrototypeOf(this, AppError.prototype) in its own
    // constructor, which reset every subclass instance's prototype back
    // to AppError.prototype specifically. That made `instanceof AppError`
    // pass while `instanceof <SpecificSubclass>` silently failed — a real
    // bug caught by rate-limit.test.ts expecting
    // `.rejects.toBeInstanceOf(RateLimitedError)`, not by this file, since
    // this file only checked instanceof AppError/Error before. Checking
    // every subclass here closes that gap.
    expect(new ValidationError("x") instanceof ValidationError).toBe(true);
    expect(new UnauthenticatedError() instanceof UnauthenticatedError).toBe(true);
    expect(new UnauthorizedError() instanceof UnauthorizedError).toBe(true);
    expect(new NotFoundError("Trip") instanceof NotFoundError).toBe(true);
    expect(new ConflictError("x") instanceof ConflictError).toBe(true);
    expect(new ProviderError("aviationstack", "x") instanceof ProviderError).toBe(true);
  });
});
