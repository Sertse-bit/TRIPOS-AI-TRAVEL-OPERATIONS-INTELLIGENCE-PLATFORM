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
});
