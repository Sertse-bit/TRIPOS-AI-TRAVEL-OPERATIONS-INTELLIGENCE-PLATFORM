import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Failure tests (Phase 28) for the audit writers. The property under test
 * is the one the module documents: an audit entry must never be the
 * reason a state change that already committed looks like it failed.
 *
 * `insertAuditLog` is stubbed to fail rather than the real database being
 * taken down — the point is the caller's contract, and breaking the pool
 * would take the rest of the suite with it.
 */
const { insertAuditLog, warn } = vi.hoisted(() => ({
  insertAuditLog: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/modules/audit/audit-repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/audit/audit-repository")>();
  return { ...actual, insertAuditLog: (...args: unknown[]) => insertAuditLog(...args) };
});

vi.mock("@/infrastructure/logger", () => ({
  logger: {
    warn: (...args: unknown[]) => warn(...args),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createRequestLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  recordAgentDelivery,
  recordSystemAction,
  recordUserAction,
} from "@/modules/audit/audit-service";

const USER_INPUT = {
  requestId: "req_audit-failure-1",
  userId: "user-1",
  action: "trip.create" as const,
  entityType: "trip",
  entityId: "trip-1",
  metadata: { title: "Committed despite the audit write failing" },
};

const AGENT_INPUT = {
  requestId: "req_audit-failure-agent",
  agentName: "flight_agent",
  userId: "user-1",
  tripId: "trip-1",
  action: "flight.status_update" as const,
  entityType: "flight",
  entityId: "flight-1",
  metadata: { changed: true, currentStatus: "DELAYED" },
};

beforeEach(() => {
  insertAuditLog.mockReset();
  warn.mockReset();
});

describe("recordUserAction", () => {
  it("never rejects into the caller, because the mutation it describes already committed", async () => {
    insertAuditLog.mockRejectedValue(new Error("audit table is gone"));

    // Fire-and-forget is the whole contract: the call returns synchronously
    // with nothing to await, so no route can turn a lost audit row into a
    // 500 for a change that was actually written.
    expect(recordUserAction(USER_INPUT)).toBeUndefined();

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  });

  it("logs the loss at warn with the requestId and action, so it is never silent", async () => {
    const error = new Error("audit table is gone");
    insertAuditLog.mockRejectedValue(error);

    recordUserAction(USER_INPUT);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      { err: error, action: "trip.create", requestId: "req_audit-failure-1" },
      "Audit write failed",
    );
  });

  it("attempts the write with honest attribution — the actor and entity are the caller's, not invented", async () => {
    insertAuditLog.mockRejectedValue(new Error("audit table is gone"));

    recordUserAction(USER_INPUT);

    await vi.waitFor(() => expect(insertAuditLog).toHaveBeenCalledTimes(1));
    expect(insertAuditLog.mock.calls[0][0]).toEqual({
      actorType: "USER",
      actorId: "user-1",
      action: "trip.create",
      entityType: "trip",
      entityId: "trip-1",
      metadata: { title: "Committed despite the audit write failing" },
      requestId: "req_audit-failure-1",
    });
  });

  it("says nothing when the write succeeds", async () => {
    insertAuditLog.mockResolvedValue(undefined);

    recordUserAction(USER_INPUT);

    await vi.waitFor(() => expect(insertAuditLog).toHaveBeenCalledTimes(1));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("recordAgentDelivery", () => {
  it("isolates a failed write the same way the user path does", async () => {
    insertAuditLog.mockRejectedValue(new Error("audit table is gone"));

    expect(recordAgentDelivery(AGENT_INPUT)).toBeUndefined();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn.mock.calls[0][0]).toMatchObject({
      action: "flight.status_update",
      requestId: "req_audit-failure-agent",
    });
  });

  it("names the agent that delivered it and carries the trip context in metadata", async () => {
    insertAuditLog.mockRejectedValue(new Error("audit table is gone"));

    recordAgentDelivery(AGENT_INPUT);

    await vi.waitFor(() => expect(insertAuditLog).toHaveBeenCalledTimes(1));
    expect(insertAuditLog.mock.calls[0][0]).toMatchObject({
      actorType: "AI_AGENT",
      actorId: "flight_agent",
      entityType: "flight",
      entityId: "flight-1",
      metadata: {
        changed: true,
        currentStatus: "DELAYED",
        tripId: "trip-1",
        userId: "user-1",
      },
    });
  });
});

describe("recordSystemAction", () => {
  it("is awaited, so a sweep cannot report a pass its audit row never recorded", async () => {
    // The deliberate asymmetry with the two writers above: a SYSTEM row
    // backs a claim the sweep is about to make ("a pass ran"), so here the
    // failure must reach the caller instead of being downgraded to a log.
    insertAuditLog.mockRejectedValue(new Error("audit table is gone"));

    await expect(
      recordSystemAction({
        action: "watch.sweep",
        entityType: "trip",
        entityId: "trip-1",
        metadata: { outcome: "ran", ownerId: "user-1" },
        requestId: "req_audit-failure-sweep",
      }),
    ).rejects.toThrow("audit table is gone");

    expect(warn).not.toHaveBeenCalled();
  });

  it("writes a SYSTEM row with no actor id when the write succeeds", async () => {
    insertAuditLog.mockResolvedValue(undefined);

    await recordSystemAction({
      action: "watch.sweep",
      entityType: "trip",
      entityId: "trip-1",
      requestId: null,
    });

    expect(insertAuditLog.mock.calls[0][0]).toMatchObject({
      actorType: "SYSTEM",
      actorId: null,
      metadata: null,
      requestId: null,
    });
  });
});
