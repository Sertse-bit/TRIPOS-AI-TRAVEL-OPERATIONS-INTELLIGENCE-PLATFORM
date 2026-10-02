import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/infrastructure/db";
import {
  addDestinationToTrip,
  addFlightToTrip,
  createTrip,
  getTripEventHistory,
} from "@/modules/trip/trip-service";
import {
  countUnreadNotifications,
  createDeduplicatedNotification,
  markNotificationRead,
} from "@/modules/notification/notification-service";
import { isMeaningfulRiskChange, monitorTrip } from "@/modules/monitor/monitor-service";
import { insertFlightStatusSnapshot } from "@/modules/trip/flight-repository";
import { getAviationProvider } from "@/integrations/aviation/provider";
import { NotFoundError } from "@/shared/errors";

/**
 * Real Postgres throughout: the anti-spam guarantee is enforced by a
 * UNIQUE index on trip_events.dedupe_key, so a mocked database would
 * assert nothing about the property that actually matters.
 *
 * The provider *adapters* are pinned rather than given a stubbed fetch,
 * because with no API key configured they resolve to the documented
 * mock adapters — which correctly answer "scheduled, clear" forever and
 * so can never produce the status transition these tests need to drive.
 * Pinning them keeps the real agents (status mapping, snapshot
 * appending, change detection, event emission) fully in play; only the
 * outside world is made controllable. Same approach Phase 15's RAG
 * tests use to pin the embedding provider.
 */
let flightStatus = "scheduled";
let flightDelay = 0;
let weatherCondition = "Clear";
let weatherWind = 8;

vi.mock("@/integrations/aviation/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/integrations/aviation/provider")>();
  const getAviationProvider = vi.fn(() => ({
    providerName: "test-aviation",
    getFlightStatus: async (flightIata: string) => ({
      flightDate: new Date().toISOString().slice(0, 10),
      flightStatus,
      airline: { name: "Test Airline", iata: "TT" },
      flight: { number: "1353", iata: flightIata },
      departure: {
        airport: "Test Departure",
        iata: "TD",
        scheduled: new Date().toISOString(),
        estimated: null,
        actual: null,
        delayMinutes: flightDelay || null,
        terminal: "1",
        gate: "A1",
      },
      arrival: {
        airport: "Test Arrival",
        iata: "TA",
        scheduled: new Date(Date.now() + 3600_000).toISOString(),
        estimated: null,
        actual: null,
        delayMinutes: flightDelay || null,
        terminal: "2",
        gate: "B2",
      },
    }),
  }));
  return { ...actual, getAviationProvider };
});

vi.mock("@/integrations/weather/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/integrations/weather/provider")>();
  return {
    ...actual,
    getWeatherProvider: vi.fn(() => ({
      providerName: "test-weather",
      getCurrentWeather: async () => ({
        locationName: "Porto",
        country: "Portugal",
        observationTime: new Date().toISOString(),
        temperatureCelsius: 14,
        windSpeedKph: weatherWind,
        precipitationMm: 0,
        humidity: 60,
        condition: weatherCondition,
      }),
    })),
  };
});

const OWNER_EMAIL = "monitor-owner@example.com";
const OTHER_EMAIL = "monitor-other@example.com";
let ownerId: string;
let otherId: string;

async function createTestUser(email: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'Test') RETURNING id`,
    [email],
  );
  return result.rows[0].id;
}

/** Points the pinned providers at a new status / reading. */
function providerState(state: {
  flightStatus?: string;
  flightDelay?: number;
  weatherCondition?: string;
  weatherWind?: number;
}) {
  flightStatus = state.flightStatus ?? "scheduled";
  flightDelay = state.flightDelay ?? 0;
  weatherCondition = state.weatherCondition ?? "Clear";
  weatherWind = state.weatherWind ?? 8;
}

async function cleanupTestUsers(): Promise<void> {
  await pool.query(
    `DELETE FROM trip_documents WHERE uploaded_by IN (SELECT id FROM users WHERE email IN ($1, $2))`,
    [OWNER_EMAIL, OTHER_EMAIL],
  );
  await pool.query(`DELETE FROM users WHERE email IN ($1, $2)`, [OWNER_EMAIL, OTHER_EMAIL]);
}

beforeEach(async () => {
  await cleanupTestUsers();
  providerState({});
  vi.mocked(getAviationProvider).mockClear();
  ownerId = await createTestUser(OWNER_EMAIL);
  otherId = await createTestUser(OTHER_EMAIL);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanupTestUsers();
});

describe("isMeaningfulRiskChange (pure)", () => {
  it("treats a severity band crossing as meaningful", () => {
    const result = isMeaningfulRiskChange({
      previousSeverity: "LOW",
      severity: "HIGH",
      previousScore: 10,
      riskScore: 55,
    });
    expect(result.severityChanged).toBe(true);
    expect(result.meaningful).toBe(true);
  });

  it("treats a small drift inside one band as not meaningful", () => {
    // This is the spam case: the score moved, nothing about the
    // traveler's situation did.
    const result = isMeaningfulRiskChange({
      previousSeverity: "HIGH",
      severity: "HIGH",
      previousScore: 62,
      riskScore: 64,
    });
    expect(result.severityChanged).toBe(false);
    expect(result.meaningful).toBe(false);
  });

  it("treats a large move inside one band as meaningful", () => {
    const result = isMeaningfulRiskChange({
      previousSeverity: "MEDIUM",
      severity: "MEDIUM",
      previousScore: 25,
      riskScore: 45,
    });
    expect(result.severityChanged).toBe(false);
    expect(result.meaningful).toBe(true);
  });

  it("treats an improvement as a severity change", () => {
    const result = isMeaningfulRiskChange({
      previousSeverity: "CRITICAL",
      severity: "LOW",
      previousScore: 80,
      riskScore: 5,
    });
    expect(result.severityChanged).toBe(true);
  });
});

describe("createDeduplicatedNotification", () => {
  const base = {
    userId: "",
    tripId: "",
    entityType: "trip",
    entityId: "",
    title: "Risk rose to HIGH",
    body: "60/100 (MEDIUM) -> 75/100 (HIGH).",
    dedupeKey: "risk_alert:trip:HIGH:escalated",
  };

  it("creates one notification and links it to the trip event", async () => {
    const trip = await createTrip(ownerId, { title: "Notify trip" });

    const outcome = await createDeduplicatedNotification({
      ...base,
      userId: ownerId,
      tripId: trip.id,
      entityId: trip.id,
    });

    expect(outcome.suppressed).toBe(false);
    expect(outcome.notification).not.toBeNull();

    const events = await getTripEventHistory(trip.id, ownerId);
    const required = events.filter((e) => e.eventType === "NOTIFICATION_REQUIRED");
    expect(required).toHaveLength(1);
  });

  it("suppresses an identical repeat instead of notifying twice", async () => {
    const trip = await createTrip(ownerId, { title: "Repeat trip" });
    const input = { ...base, userId: ownerId, tripId: trip.id, entityId: trip.id };

    const first = await createDeduplicatedNotification(input);
    const second = await createDeduplicatedNotification(input);
    const third = await createDeduplicatedNotification(input);

    expect(first.suppressed).toBe(false);
    expect(second.suppressed).toBe(true);
    expect(second.notification).toBeNull();
    expect(third.suppressed).toBe(true);

    expect(await countUnreadNotifications(ownerId)).toBe(1);
  });

  it("suppresses repeats of one severity but alerts on a genuinely new one", async () => {
    // HIGH -> CRITICAL -> HIGH: each arrival is new information, so
    // each is allowed through. Deduplicating on trip alone would
    // swallow the CRITICAL, which is the worst possible time to be
    // silent.
    const trip = await createTrip(ownerId, { title: "Recurring trip" });
    const key = (severity: string) => `risk_alert:${trip.id}:${severity}:escalated`;

    const high = await createDeduplicatedNotification({
      ...base,
      userId: ownerId,
      tripId: trip.id,
      entityId: trip.id,
      dedupeKey: key("HIGH"),
    });
    const highAgain = await createDeduplicatedNotification({
      ...base,
      userId: ownerId,
      tripId: trip.id,
      entityId: trip.id,
      dedupeKey: key("HIGH"),
    });
    const critical = await createDeduplicatedNotification({
      ...base,
      userId: ownerId,
      tripId: trip.id,
      entityId: trip.id,
      title: "Risk rose to CRITICAL",
      dedupeKey: key("CRITICAL"),
    });

    expect(high.suppressed).toBe(false);
    expect(highAgain.suppressed).toBe(true); // unchanged condition
    expect(critical.suppressed).toBe(false); // genuinely worse
  });
});

describe("markNotificationRead", () => {
  it("marks the caller's own notification and refuses anyone else's", async () => {
    const trip = await createTrip(ownerId, { title: "Read trip" });
    const { notification } = await createDeduplicatedNotification({
      userId: ownerId,
      tripId: trip.id,
      entityType: "trip",
      entityId: trip.id,
      title: "t",
      body: "b",
      dedupeKey: `read:${trip.id}`,
    });

    expect(await markNotificationRead(ownerId, notification!.id)).toBe(true);
    // Already read -> no-op, so a double-click can't double-apply.
    expect(await markNotificationRead(ownerId, notification!.id)).toBe(false);
    // Another user marking it is simply "not updated" — the same answer
    // as a nonexistent id, so ids can't be probed.
    expect(await markNotificationRead(otherId, notification!.id)).toBe(false);
    expect(await countUnreadNotifications(ownerId)).toBe(0);
  });
});

describe("monitorTrip", () => {
  async function tripWithFlight(flightNumber = "TP1353") {
    const trip = await createTrip(ownerId, { title: "Monitored trip" });
    await addDestinationToTrip(trip.id, ownerId, { city: "Porto", country: "Portugal" });
    const flight = await addFlightToTrip(trip.id, ownerId, {
      flightNumber,
      airline: "TAP",
      departureAirport: "LIS",
      arrivalAirport: "OPO",
      scheduledDeparture: new Date(Date.now() + 6 * 60 * 60 * 1000),
      scheduledArrival: new Date(Date.now() + 8 * 60 * 60 * 1000),
    });
    return { trip, flight };
  }

  it("checks every flight and destination and recomputes risk", async () => {
    const { trip } = await tripWithFlight();

    const result = await monitorTrip(trip.id, ownerId);

    expect(result.checkedFlights).toHaveLength(1);
    expect(result.checkedDestinations).toHaveLength(1);
    expect(result.checkedFlights[0].skipped).toBe(false);
    expect(result.checkedDestinations[0].skipped).toBe(false);
    expect(result.riskChange).not.toBeNull();
    expect(result.riskChange!.riskScore).toBeGreaterThanOrEqual(0);
  });

  it("records a change only when the flight status genuinely changed", async () => {
    const { trip, flight } = await tripWithFlight();
    // A prior snapshot of SCHEDULED; the provider now says cancelled.
    await insertFlightStatusSnapshot({
      flightRecordId: flight.id,
      status: "SCHEDULED",
      fetchedAt: new Date(Date.now() - 60_000),
    });

    providerState({ flightStatus: "cancelled" });

    const result = await monitorTrip(trip.id, ownerId);

    expect(result.checkedFlights[0].previousStatus).toBe("SCHEDULED");
    expect(result.checkedFlights[0].status).toBe("CANCELLED");
    expect(result.checkedFlights[0].changed).toBe(true);
    expect(result.flightsChanged).toBe(1);

    const events = await getTripEventHistory(trip.id, ownerId);
    expect(events.some((e) => e.eventType === "FLIGHT_UPDATED")).toBe(true);
  });
  it("raises an alert when an already-monitored trip gets worse", async () => {
    const { trip, flight } = await tripWithFlight();
    await insertFlightStatusSnapshot({
      flightRecordId: flight.id,
      status: "SCHEDULED",
      fetchedAt: new Date(Date.now() - 60_000),
    });

    // Baseline pass: the trip is healthy, so this establishes what the
    // traveler last saw.
    const baseline = await monitorTrip(trip.id, ownerId);
    expect(baseline.alert).toBeNull();
    expect(baseline.riskChange!.severity).not.toBe("CRITICAL");

    providerState({ flightStatus: "cancelled" });

    const result = await monitorTrip(trip.id, ownerId);

    expect(result.riskChange!.severity).toBe("CRITICAL");
    expect(result.riskChange!.severityChanged).toBe(true);
    expect(result.alert).not.toBeNull();
    expect(result.alertSuppressed).toBe(false);
    expect(await countUnreadNotifications(ownerId)).toBe(1);
  });

  it("does not alert on a trip's first pass — it has no prior state to change from", async () => {
    const { trip } = await tripWithFlight();
    providerState({ flightStatus: "cancelled" });

    const result = await monitorTrip(trip.id, ownerId);

    // The score is CRITICAL and fully visible in the UI; there is no
    // movement to report, and alerting on "start watching this" would
    // be noise.
    expect(result.riskChange!.severity).toBe("CRITICAL");
    expect(result.alert).toBeNull();
    expect(await countUnreadNotifications(ownerId)).toBe(0);
  });

  it("does not alert again when nothing has changed since the last pass", async () => {
    const { trip, flight } = await tripWithFlight();
    await insertFlightStatusSnapshot({
      flightRecordId: flight.id,
      status: "SCHEDULED",
      fetchedAt: new Date(Date.now() - 120_000),
    });

    // Baseline, then the cancellation becomes news.
    await monitorTrip(trip.id, ownerId);
    providerState({ flightStatus: "cancelled" });
    const first = await monitorTrip(trip.id, ownerId);
    expect(first.alert).not.toBeNull();

    // Same cancellation, no new information — the core anti-spam case.
    const second = await monitorTrip(trip.id, ownerId);
    expect(second.checkedFlights[0].changed).toBe(false);
    expect(second.alert).toBeNull();
    expect(await countUnreadNotifications(ownerId)).toBe(1);
  });

  it("reports a failed provider check as skipped, never as unchanged", async () => {
    const { trip } = await tripWithFlight();
    vi.mocked(getAviationProvider).mockImplementationOnce(() => {
      throw new Error("provider unreachable");
    });

    const result = await monitorTrip(trip.id, ownerId);

    // The dangerous failure mode is reporting a broken check as a
    // healthy one, so this is asserted explicitly.
    expect(result.checkedFlights[0].skipped).toBe(true);
    expect(result.checkedFlights[0].changed).toBe(false);
    expect(result.checkedFlights[0].error).toBeTruthy();
  });

  it("rejects a caller who does not own the trip", async () => {
    const { trip } = await tripWithFlight();
    await expect(monitorTrip(trip.id, otherId)).rejects.toBeInstanceOf(NotFoundError);
  });

  // --- Phase 19: the caller's own floor on being interrupted ---------------
  //
  // The scenario is deliberately a HIGH, not a CRITICAL: a weather shift
  // from an ordinary 8 kph to 60 kph moves this fixture's score 26 -> 38,
  // which crosses MEDIUM -> HIGH (a materially changed situation) without
  // a cancelled flight, so "do not interrupt me below X" has something
  // real to suppress.

  it("does not notify below the caller's severity floor, but still records the assessment", async () => {
    const { trip } = await tripWithFlight();
    await monitorTrip(trip.id, ownerId);
    providerState({ weatherWind: 60 });

    const result = await monitorTrip(trip.id, ownerId, { minimumAlertSeverity: "CRITICAL" });

    expect(result.riskChange!.severity).toBe("HIGH");
    expect(result.riskChange!.severityChanged).toBe(true);
    // The change is real, the record is real — only the interruption was
    // declined, and that is reported as its own outcome rather than as
    // "nothing happened".
    expect(result.alert).toBeNull();
    expect(result.alertSuppressed).toBe(true);
    expect(result.alertSuppressionReason).toBe("below-threshold");
    expect(await countUnreadNotifications(ownerId)).toBe(0);

    const stored = await pool.query<{ severity: string; risk_score: number }>(
      `SELECT severity::text AS severity, risk_score
         FROM risk_assessments WHERE trip_id = $1
        ORDER BY generated_at DESC LIMIT 1`,
      [trip.id],
    );
    expect(stored.rows[0].severity).toBe("HIGH");
  });

  it("notifies when the change is at or above the floor", async () => {
    const { trip } = await tripWithFlight();
    await monitorTrip(trip.id, ownerId);
    providerState({ weatherWind: 60 });

    const result = await monitorTrip(trip.id, ownerId, { minimumAlertSeverity: "HIGH" });

    expect(result.riskChange!.severity).toBe("HIGH");
    expect(result.alert).not.toBeNull();
    expect(result.alertSuppressionReason).toBeNull();
    expect(await countUnreadNotifications(ownerId)).toBe(1);
  });
});
