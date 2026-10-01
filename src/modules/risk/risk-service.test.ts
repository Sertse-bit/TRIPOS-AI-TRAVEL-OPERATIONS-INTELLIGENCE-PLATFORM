import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/infrastructure/db";
import {
  addDestinationToTrip,
  addFlightToTrip,
  addTravelerToTrip,
  createTrip,
  getTripEventHistory,
} from "@/modules/trip/trip-service";
import { insertFlightStatusSnapshot } from "@/modules/trip/flight-repository";
import { recordWeatherSnapshot } from "@/modules/trip/trip-service";
import {
  assessTripRisk,
  getLatestTripRisk,
  listTripRiskAssessments,
} from "@/modules/risk/risk-service";
import { NotFoundError } from "@/shared/errors";

/**
 * These run against real PostgreSQL. The behavior under test is largely
 * "does this module read the trip's real rows and write them back
 * honestly" — ownership scoping, append-only history, and the enum cast
 * on `severity` are all things a mocked pool would assert nothing about.
 */

const OWNER_EMAIL = "risk-owner@example.com";
const OTHER_EMAIL = "risk-other@example.com";
let ownerId: string;
let otherId: string;

async function createTestUser(email: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'Test') RETURNING id`,
    [email],
  );
  return result.rows[0].id;
}

async function insertDocument(
  tripId: string,
  userId: string,
  filename: string,
  status: "READY" | "FAILED",
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO trip_documents
       (trip_id, uploaded_by, original_filename, storage_key, mime_type, size_bytes, status)
     VALUES ($1, $2, $3, $4, 'application/pdf', 100, $5::"DocumentStatus")
     RETURNING id`,
    [tripId, userId, filename, `risk-${filename}`, status],
  );
  return result.rows[0].id;
}

/** One chunk row, enough to make a document count as "indexed". */
async function insertChunk(documentId: string): Promise<void> {
  const vector = `[${new Array(1024).fill(0).join(",")}]`;
  await pool.query(
    `INSERT INTO document_chunks (trip_document_id, chunk_index, content, token_count, embedding)
     VALUES ($1, 0, 'chunk text', 2, $2::vector)`,
    [documentId, vector],
  );
}

async function cleanupTestUsers(): Promise<void> {
  // trip_documents.uploaded_by is a plain FK to users with no cascade
  // (chunks cascade from documents, documents from trips) — so the
  // documents go first, exactly as document-service.test.ts does.
  await pool.query(
    `DELETE FROM trip_documents WHERE uploaded_by IN (SELECT id FROM users WHERE email IN ($1, $2))`,
    [OWNER_EMAIL, OTHER_EMAIL],
  );
  await pool.query(`DELETE FROM users WHERE email IN ($1, $2)`, [OWNER_EMAIL, OTHER_EMAIL]);
}

// Cleaned in beforeEach as well as afterEach: a previous run that failed
// mid-teardown would otherwise leave rows behind and every insert here
// would fail on the unique email constraint.
beforeEach(async () => {
  await cleanupTestUsers();
  ownerId = await createTestUser(OWNER_EMAIL);
  otherId = await createTestUser(OTHER_EMAIL);
});

afterEach(async () => {
  await cleanupTestUsers();
});

describe("assessTripRisk", () => {
  it("scores a real trip from its stored rows and persists the result", async () => {
    const trip = await createTrip(ownerId, { title: "Risk trip" });
    await addTravelerToTrip(trip.id, ownerId, { fullName: "Selam Tesfaye" });
    const destination = await addDestinationToTrip(trip.id, ownerId, {
      city: "Porto",
      country: "Portugal",
    });
    const flight = await addFlightToTrip(trip.id, ownerId, {
      flightNumber: "TP1353",
      airline: "TAP",
      departureAirport: "LIS",
      arrivalAirport: "OPO",
      scheduledDeparture: new Date(Date.now() + 3 * 60 * 60 * 1000),
      scheduledArrival: new Date(Date.now() + 4 * 60 * 60 * 1000),
    });

    await insertFlightStatusSnapshot({
      flightRecordId: flight.id,
      status: "DELAYED",
      delayMinutes: 180,
      fetchedAt: new Date(),
    });
    await recordWeatherSnapshot(trip.id, ownerId, destination.id, {
      temperatureCelsius: 14,
      condition: "Rain",
      windSpeedKph: 55,
      precipitationMm: 9,
      fetchedAt: new Date(),
    });
    const documentId = await insertDocument(trip.id, ownerId, "boarding-pass.pdf", "READY");
    await insertChunk(documentId);

    const result = await assessTripRisk(trip.id, ownerId);

    expect(result.assessment.tripId).toBe(trip.id);
    expect(result.assessment.riskScore).toBeGreaterThan(0);
    expect(result.assessment.riskScore).toBeLessThanOrEqual(100);
    expect(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).toContain(result.assessment.severity);

    // Evidence is the trip's own real values, not a summary of nothing.
    expect(result.evidence.flights[0]).toMatchObject({
      flightNumber: "TP1353",
      status: "DELAYED",
      delayMinutes: 180,
    });
    expect(result.evidence.weather[0]).toMatchObject({ city: "Porto", windSpeedKph: 55 });
    expect(result.evidence.documents).toMatchObject({ total: 1, ready: 1, indexedChunks: 1 });
    expect(result.evidence.operationalState).toBe("ATTENTION_NEEDED");

    const factor = result.factors.find((f) => f.key === "flightDisruption");
    expect(factor?.detail).toContain("TP1353");
    expect(factor?.detail).toContain("180");
  });

  it("writes the enum column and JSON columns as real typed values", async () => {
    const trip = await createTrip(ownerId, { title: "Typed trip" });
    await addDestinationToTrip(trip.id, ownerId, { city: "Rome", country: "Italy" });

    const { assessment } = await assessTripRisk(trip.id, ownerId);

    const row = await pool.query<{ severity: string; factors: unknown; evidence: unknown }>(
      `SELECT severity, factors, evidence FROM risk_assessments WHERE id = $1`,
      [assessment.id],
    );
    expect(row.rows[0].severity).toBe(assessment.severity);
    expect(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).toContain(row.rows[0].severity);
    expect(Array.isArray(row.rows[0].factors)).toBe(true);
    expect(typeof row.rows[0].evidence).toBe("object");
  });

  it("raises severity when a flight is cancelled", async () => {
    const calm = await createTrip(ownerId, { title: "Calm" });
    await addDestinationToTrip(calm.id, ownerId, { city: "Rome", country: "Italy" });
    await addTravelerToTrip(calm.id, ownerId, { fullName: "Test" });
    const calmFlight = await addFlightToTrip(calm.id, ownerId, {
      flightNumber: "OK1",
      airline: "TAP",
      departureAirport: "LIS",
      arrivalAirport: "FCO",
      scheduledDeparture: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      scheduledArrival: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
    });
    await insertFlightStatusSnapshot({
      flightRecordId: calmFlight.id,
      status: "SCHEDULED",
      fetchedAt: new Date(),
    });

    const disrupted = await createTrip(ownerId, { title: "Disrupted" });
    await addDestinationToTrip(disrupted.id, ownerId, { city: "Rome", country: "Italy" });
    await addTravelerToTrip(disrupted.id, ownerId, { fullName: "Test" });
    const badFlight = await addFlightToTrip(disrupted.id, ownerId, {
      flightNumber: "BAD1",
      airline: "TAP",
      departureAirport: "LIS",
      arrivalAirport: "FCO",
      scheduledDeparture: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      scheduledArrival: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
    });
    await insertFlightStatusSnapshot({
      flightRecordId: badFlight.id,
      status: "CANCELLED",
      fetchedAt: new Date(),
    });

    const calmRisk = await assessTripRisk(calm.id, ownerId);
    const badRisk = await assessTripRisk(disrupted.id, ownerId);

    expect(badRisk.assessment.riskScore).toBeGreaterThan(calmRisk.assessment.riskScore);
    expect(badRisk.assessment.severity).toBe("CRITICAL");
  });

  it("appends a new assessment and a RISK_ASSESSMENT_GENERATED event each time", async () => {
    const trip = await createTrip(ownerId, { title: "History trip" });
    await addDestinationToTrip(trip.id, ownerId, { city: "Lisbon", country: "Portugal" });

    await assessTripRisk(trip.id, ownerId);
    await assessTripRisk(trip.id, ownerId);

    const history = await listTripRiskAssessments(trip.id, ownerId);
    expect(history).toHaveLength(2);

    const events = await getTripEventHistory(trip.id, ownerId);
    const generated = events.filter((e) => e.eventType === "RISK_ASSESSMENT_GENERATED");
    expect(generated).toHaveLength(2);
    expect(generated[0].metadata).toMatchObject({ severity: expect.any(String) });
  });

  it("returns a stable score when nothing about the trip has changed", async () => {
    const trip = await createTrip(ownerId, { title: "Stable trip" });
    await addDestinationToTrip(trip.id, ownerId, { city: "Berlin", country: "Germany" });

    const first = await assessTripRisk(trip.id, ownerId);
    const second = await assessTripRisk(trip.id, ownerId);

    expect(second.assessment.riskScore).toBe(first.assessment.riskScore);
    expect(second.assessment.severity).toBe(first.assessment.severity);
  });

  it("rejects a caller who does not own the trip", async () => {
    const trip = await createTrip(ownerId, { title: "Private trip" });
    await addDestinationToTrip(trip.id, ownerId, { city: "Rome", country: "Italy" });

    // NotFoundError, not a 403 — same anti-enumeration rule as every
    // other trip operation.
    await expect(assessTripRisk(trip.id, otherId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listTripRiskAssessments(trip.id, otherId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getLatestTripRisk(trip.id, otherId)).rejects.toBeInstanceOf(NotFoundError);

    // ...and nothing was written.
    const count = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM risk_assessments WHERE trip_id = $1`,
      [trip.id],
    );
    expect(count.rows[0].count).toBe(0);
  });

  it("never scores another trip's documents or chunks as its own", async () => {
    const mine = await createTrip(ownerId, { title: "My trip" });
    await addDestinationToTrip(mine.id, ownerId, { city: "Rome", country: "Italy" });
    await insertDocument(mine.id, ownerId, "mine.pdf", "READY");

    const theirs = await createTrip(otherId, { title: "Their trip" });
    await addDestinationToTrip(theirs.id, otherId, { city: "Rome", country: "Italy" });
    const theirDocument = await insertDocument(theirs.id, otherId, "theirs.pdf", "READY");
    await insertChunk(theirDocument);

    const result = await assessTripRisk(mine.id, ownerId);

    expect(result.evidence.documents.total).toBe(1);
    expect(result.evidence.documents.indexedChunks).toBe(0);
  });
});

describe("getTripIndexStatus", () => {
  it("reports which documents are indexed, not just how many chunks exist", async () => {
    const trip = await createTrip(ownerId, { title: "Index status trip" });
    await addDestinationToTrip(trip.id, ownerId, { city: "Rome", country: "Italy" });
    const indexed = await insertDocument(trip.id, ownerId, "indexed.pdf", "READY");
    await insertDocument(trip.id, ownerId, "unindexed.pdf", "READY");
    await insertChunk(indexed);

    const { getTripIndexStatus } = await import("@/modules/trip/rag-service");
    const status = await getTripIndexStatus(trip.id, ownerId);

    expect(status.indexedChunks).toBe(1);
    expect(status.indexedDocumentIds).toEqual([indexed]);
  });
});
