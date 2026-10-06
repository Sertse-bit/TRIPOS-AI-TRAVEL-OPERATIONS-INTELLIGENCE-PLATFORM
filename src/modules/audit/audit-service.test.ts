import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/infrastructure/db";
import { createTrip } from "@/modules/trip/trip-service";
import { runDueWatches, upsertTripWatch } from "@/modules/monitor/watch-service";
import {
  getTripAuditTrail,
  getUserAuditTrail,
  recordAgentDelivery,
  recordSystemAction,
  recordUserAction,
} from "@/modules/audit/audit-service";
import { NotFoundError } from "@/shared/errors";

/**
 * Real Postgres throughout — the properties under test are database
 * properties: JSONB metadata round-trips, ActorType enum enforcement,
 * the entity/metadata scoping that stands in for the foreign keys the
 * table deliberately lacks, and the ordering the UI relies on.
 *
 * `recordUserAction` and `recordAgentDelivery` are fire-and-forget by
 * contract (they must never be the reason a committed mutation reports
 * failure), so tests synchronize on the row actually appearing with
 * `vi.waitFor` instead of sleeping.
 */
const OWNER_EMAIL = "audit-owner@example.com";
const OTHER_EMAIL = "audit-other@example.com";

let ownerId: string;
let otherId: string;
const tripIds: string[] = [];

async function createTestUser(email: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'Test') RETURNING id`,
    [email],
  );
  return result.rows[0].id;
}

async function cleanup(): Promise<void> {
  await pool.query(
    `DELETE FROM audit_logs
      WHERE actor_id = ANY($1::text[])
         OR metadata->>'userId' = ANY($1::text[])
         OR metadata->>'ownerId' = ANY($1::text[])
         OR (entity_type = 'trip' AND entity_id = ANY($2::text[]))`,
    [[ownerId, otherId], tripIds],
  );
  // trip_documents before users (known cleanup order), users cascades trips.
  await pool.query(
    `DELETE FROM trip_documents WHERE uploaded_by IN (SELECT id FROM users WHERE email IN ($1, $2))`,
    [OWNER_EMAIL, OTHER_EMAIL],
  );
  await pool.query(`DELETE FROM users WHERE email IN ($1, $2)`, [OWNER_EMAIL, OTHER_EMAIL]);
  tripIds.length = 0;
}

beforeEach(async () => {
  await cleanup();
  ownerId = await createTestUser(OWNER_EMAIL);
  otherId = await createTestUser(OTHER_EMAIL);
});

afterEach(cleanup);

describe("recordUserAction", () => {
  it("records a USER entry with the requestId and JSONB metadata intact", async () => {
    const trip = await createTrip(ownerId, { title: "Audited trip" });
    tripIds.push(trip.id);

    recordUserAction({
      requestId: "req_audit-user-1",
      userId: ownerId,
      action: "trip.create",
      entityType: "trip",
      entityId: trip.id,
      metadata: { title: "Audited trip", nested: { days: 5 } },
    });

    await vi.waitFor(async () => {
      const page = await getTripAuditTrail(trip.id, ownerId);
      expect(page.entries).toHaveLength(1);
      const entry = page.entries[0];
      expect(entry.actorType).toBe("USER");
      expect(entry.actorId).toBe(ownerId);
      expect(entry.action).toBe("trip.create");
      expect(entry.entityType).toBe("trip");
      expect(entry.entityId).toBe(trip.id);
      expect(entry.requestId).toBe("req_audit-user-1");
      expect(entry.metadata).toEqual({ title: "Audited trip", nested: { days: 5 } });
    });
  });

  it("orders entries newest-first so the page can render without re-sorting", async () => {
    const trip = await createTrip(ownerId, { title: "Ordering" });
    tripIds.push(trip.id);

    recordUserAction({
      requestId: "req_order-1",
      userId: ownerId,
      action: "trip.update",
      entityType: "trip",
      entityId: trip.id,
      metadata: { step: "first" },
    });
    await vi.waitFor(async () => {
      expect((await getTripAuditTrail(trip.id, ownerId)).entries).toHaveLength(1);
    });

    recordUserAction({
      requestId: "req_order-2",
      userId: ownerId,
      action: "destination.add",
      entityType: "destination",
      entityId: crypto.randomUUID(),
      metadata: { step: "second", tripId: trip.id, userId: ownerId },
    });
    await vi.waitFor(async () => {
      const page = await getTripAuditTrail(trip.id, ownerId);
      expect(page.entries).toHaveLength(2);
      expect(page.entries[0].action).toBe("destination.add");
      expect(page.entries[1].action).toBe("trip.update");
    });
  });
});

describe("recordAgentDelivery", () => {
  it("attributes persisted deliveries to the named agent, with trip context in metadata", async () => {
    const trip = await createTrip(ownerId, { title: "Agent work" });
    tripIds.push(trip.id);
    const flightId = crypto.randomUUID();

    recordAgentDelivery({
      requestId: "req_audit-agent-1",
      agentName: "flight_agent",
      userId: ownerId,
      tripId: trip.id,
      action: "flight.status_update",
      entityType: "flight",
      entityId: flightId,
      metadata: { changed: true, currentStatus: "delayed" },
    });

    await vi.waitFor(async () => {
      const page = await getTripAuditTrail(trip.id, ownerId);
      expect(page.entries).toHaveLength(1);
      const entry = page.entries[0];
      expect(entry.actorType).toBe("AI_AGENT");
      expect(entry.actorId).toBe("flight_agent");
      expect(entry.entityType).toBe("flight");
      expect(entry.entityId).toBe(flightId);
      expect(entry.metadata).toMatchObject({
        changed: true,
        currentStatus: "delayed",
        tripId: trip.id,
        userId: ownerId,
      });
    });
  });
});

describe("recordSystemAction", () => {
  it("attributes a sweep pass to SYSTEM with no actor id, and skips nothing-it-did passes", async () => {
    const trip = await createTrip(ownerId, { title: "Watched" });
    tripIds.push(trip.id);
    await upsertTripWatch(trip.id, ownerId, {});

    const sweep = await runDueWatches({ ownerId, auditRequestId: "req_audit-sweep-1" });
    expect(sweep.passes).toHaveLength(1);
    expect(sweep.passes[0].outcome).toBe("ran");

    // recordSystemAction is awaited inside the sweep, so the row exists
    // the moment runDueWatches resolves — no waiting needed.
    const page = await getTripAuditTrail(trip.id, ownerId);
    expect(page.entries).toHaveLength(1);
    const entry = page.entries[0];
    expect(entry.actorType).toBe("SYSTEM");
    expect(entry.actorId).toBeNull();
    expect(entry.action).toBe("watch.sweep");
    expect(entry.entityType).toBe("trip");
    expect(entry.entityId).toBe(trip.id);
    expect(entry.requestId).toBe("req_audit-sweep-1");
    expect(entry.metadata).toMatchObject({ outcome: "ran", ownerId });
  });

  it("writes a standalone system entry when called directly", async () => {
    const trip = await createTrip(ownerId, { title: "System direct" });
    tripIds.push(trip.id);

    await recordSystemAction({
      action: "watch.sweep",
      entityType: "trip",
      entityId: trip.id,
      metadata: { outcome: "ran", ownerId },
      requestId: null,
    });

    const page = await getTripAuditTrail(trip.id, ownerId);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].actorType).toBe("SYSTEM");
    expect(page.entries[0].requestId).toBeNull();
  });
});

describe("audit trail access control", () => {
  it("a stranger's trip is indistinguishable from an unknown one", async () => {
    const trip = await createTrip(ownerId, { title: "Private" });
    tripIds.push(trip.id);

    await expect(getTripAuditTrail(trip.id, otherId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an account-level action with no trip appears on the stream but on no trip's trail", async () => {
    const trip = await createTrip(ownerId, { title: "Has a trail" });
    tripIds.push(trip.id);

    // The shape an auth.login / notification.read entry takes: the actor
    // names the user, and nothing names a trip.
    recordUserAction({
      requestId: "req_account-level",
      userId: ownerId,
      action: "auth.login",
      entityType: "user",
      entityId: ownerId,
    });

    await vi.waitFor(async () => {
      const stream = await getUserAuditTrail(ownerId);
      expect(stream.entries).toHaveLength(1);
      expect(stream.entries[0].action).toBe("auth.login");
      expect(stream.entries[0].entityType).toBe("user");
      expect(stream.entries[0].requestId).toBe("req_account-level");
    });

    // Reaching the trip trail would mean the trip filter is a lie.
    const trail = await getTripAuditTrail(trip.id, ownerId);
    expect(trail.total).toBe(0);
  });

  it("the user-wide stream only contains the caller's own trips", async () => {
    const own = await createTrip(ownerId, { title: "Mine" });
    const foreign = await createTrip(otherId, { title: "Not mine" });
    tripIds.push(own.id, foreign.id);

    for (const trip of [own, foreign]) {
      recordUserAction({
        requestId: "req_stream",
        userId: trip.id === own.id ? ownerId : otherId,
        action: "trip.create",
        entityType: "trip",
        entityId: trip.id,
        metadata: { tripId: trip.id, userId: trip.id === own.id ? ownerId : otherId },
      });
    }

    await vi.waitFor(async () => {
      const mine = await getUserAuditTrail(ownerId);
      expect(mine.entries).toHaveLength(1);
      expect(mine.entries[0].entityId).toBe(own.id);
      const theirs = await getUserAuditTrail(otherId);
      expect(theirs.entries).toHaveLength(1);
      expect(theirs.entries[0].entityId).toBe(foreign.id);
    });
  });
});

describe("paging and filtering", () => {
  it("pages with an honest total, and filters by actor type", async () => {
    const trip = await createTrip(ownerId, { title: "Paged" });
    tripIds.push(trip.id);

    for (let step = 1; step <= 3; step += 1) {
      recordUserAction({
        requestId: `req_page-${step}`,
        userId: ownerId,
        action: "trip.update",
        entityType: "trip",
        entityId: trip.id,
        metadata: { step, tripId: trip.id, userId: ownerId },
      });
    }
    recordAgentDelivery({
      requestId: "req_page-agent",
      agentName: "weather_agent",
      userId: ownerId,
      tripId: trip.id,
      action: "weather.snapshot_recorded",
      entityType: "destination",
      entityId: crypto.randomUUID(),
      metadata: { significant: false },
    });

    await vi.waitFor(async () => {
      expect((await getTripAuditTrail(trip.id, ownerId)).total).toBe(4);
    });

    const firstPage = await getTripAuditTrail(trip.id, ownerId, { limit: 2 });
    expect(firstPage.entries).toHaveLength(2);
    expect(firstPage.total).toBe(4);

    const secondPage = await getTripAuditTrail(trip.id, ownerId, { limit: 2, offset: 2 });
    expect(secondPage.entries).toHaveLength(2);
    expect(firstPage.entries[0].id).not.toBe(secondPage.entries[0].id);

    const agentsOnly = await getTripAuditTrail(trip.id, ownerId, { actorType: "AI_AGENT" });
    expect(agentsOnly.total).toBe(1);
    expect(agentsOnly.entries[0].actorType).toBe("AI_AGENT");

    const usersOnly = await getTripAuditTrail(trip.id, ownerId, { actorType: "USER" });
    expect(usersOnly.total).toBe(3);
  });
});
