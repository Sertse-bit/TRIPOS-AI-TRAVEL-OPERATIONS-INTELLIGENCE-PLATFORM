import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/infrastructure/db";
import {
  addDestinationToTrip,
  addFlightToTrip,
  addTravelerToTrip,
  calculateOperationalState,
  changeTripStatus,
  createTrip,
  getTrip,
  getTripDigitalTwin,
  getTripEventHistory,
  listUserTrips,
  updateTripDetails,
} from "@/modules/trip/trip-service";
import { NotFoundError } from "@/shared/errors";

// Two real users so ownership/authorization boundaries can be tested
// against actual foreign-key-backed rows, not mocks.
const OWNER_EMAIL = "trip-owner@example.com";
const OTHER_EMAIL = "trip-other@example.com";
let ownerId: string;
let otherId: string;

async function createTestUser(email: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'Test') RETURNING id`,
    [email],
  );
  return result.rows[0].id;
}

beforeEach(async () => {
  ownerId = await createTestUser(OWNER_EMAIL);
  otherId = await createTestUser(OTHER_EMAIL);
});

afterEach(async () => {
  // Cascades to everything FK'd to these users' trips (Phase 3's
  // verified ON DELETE CASCADE design), so this alone is sufficient cleanup.
  await pool.query(`DELETE FROM users WHERE email IN ($1, $2)`, [OWNER_EMAIL, OTHER_EMAIL]);
});

describe("trip CRUD and authorization", () => {
  it("creates a trip and records a TRIP_CREATED event", async () => {
    const trip = await createTrip(ownerId, { title: "Addis to Dubai" });
    expect(trip.title).toBe("Addis to Dubai");
    expect(trip.status).toBe("PLANNING");

    const events = await getTripEventHistory(trip.id, ownerId);
    expect(events.some((e) => e.eventType === "TRIP_CREATED")).toBe(true);
  });

  it("lists only the requesting user's trips", async () => {
    await createTrip(ownerId, { title: "Owner trip 1" });
    await createTrip(ownerId, { title: "Owner trip 2" });
    await createTrip(otherId, { title: "Someone else's trip" });

    const ownerTrips = await listUserTrips(ownerId);
    expect(ownerTrips).toHaveLength(2);
    expect(ownerTrips.every((t) => t.userId === ownerId)).toBe(true);
  });

  it("throws NotFoundError for a trip that genuinely doesn't exist", async () => {
    await expect(getTrip("00000000-0000-0000-0000-000000000000", ownerId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("throws the SAME NotFoundError (not Unauthorized) when a different user requests someone else's trip", async () => {
    // Deliberate design choice, documented in trip-service.ts: don't let
    // a user distinguish "doesn't exist" from "exists but isn't yours"
    // via a different error/status code -- that difference is itself an
    // enumeration oracle.
    const trip = await createTrip(ownerId, { title: "Private trip" });
    await expect(getTrip(trip.id, otherId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("updates trip details and records a TRIP_UPDATED event", async () => {
    const trip = await createTrip(ownerId, { title: "Original title" });
    const updated = await updateTripDetails(trip.id, ownerId, { title: "New title" });
    expect(updated.title).toBe("New title");

    const events = await getTripEventHistory(trip.id, ownerId);
    expect(events.some((e) => e.eventType === "TRIP_UPDATED")).toBe(true);
  });

  it("prevents a non-owner from updating a trip", async () => {
    const trip = await createTrip(ownerId, { title: "Owner's trip" });
    await expect(updateTripDetails(trip.id, otherId, { title: "Hijacked" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("changes trip status and records the from/to in the event", async () => {
    const trip = await createTrip(ownerId, { title: "Status test" });
    const updated = await changeTripStatus(trip.id, ownerId, "UPCOMING");
    expect(updated.status).toBe("UPCOMING");

    const events = await getTripEventHistory(trip.id, ownerId);
    const statusEvent = events.find((e) => e.eventType === "TRIP_STATUS_CHANGED");
    expect(statusEvent?.metadata).toMatchObject({ from: "PLANNING", to: "UPCOMING" });
  });
});

describe("travelers, destinations, flights", () => {
  it("adds a traveler and records an event", async () => {
    const trip = await createTrip(ownerId, { title: "Family trip" });
    const traveler = await addTravelerToTrip(trip.id, ownerId, { fullName: "Alice Traveler" });
    expect(traveler.fullName).toBe("Alice Traveler");

    const events = await getTripEventHistory(trip.id, ownerId);
    expect(events.some((e) => e.eventType === "TRAVELER_ADDED")).toBe(true);
  });

  it("adds a destination with geo coordinates", async () => {
    const trip = await createTrip(ownerId, { title: "Dubai trip" });
    const destination = await addDestinationToTrip(trip.id, ownerId, {
      city: "Dubai",
      country: "UAE",
      latitude: 25.2048,
      longitude: 55.2708,
    });
    expect(destination.city).toBe("Dubai");
    expect(destination.latitude).toBe(25.2048);
  });

  it("adds a flight record", async () => {
    const trip = await createTrip(ownerId, { title: "Flight trip" });
    const flight = await addFlightToTrip(trip.id, ownerId, {
      flightNumber: "ET602",
      airline: "Ethiopian Airlines",
      departureAirport: "ADD",
      arrivalAirport: "DXB",
      scheduledDeparture: new Date("2026-09-10T08:00:00Z"),
      scheduledArrival: new Date("2026-09-10T13:30:00Z"),
    });
    expect(flight.flightNumber).toBe("ET602");
  });

  it("rejects adding a traveler to a trip you don't own", async () => {
    const trip = await createTrip(ownerId, { title: "Private" });
    await expect(
      addTravelerToTrip(trip.id, otherId, { fullName: "Intruder" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("calculateOperationalState", () => {
  it("returns INCOMPLETE when a trip has no destinations or flights", async () => {
    const trip = await createTrip(ownerId, { title: "Empty trip" });
    const state = await calculateOperationalState(trip.id, ownerId);
    expect(state.state).toBe("INCOMPLETE");
  });

  it("returns ON_TRACK when flights exist with no disruptive snapshot", async () => {
    const trip = await createTrip(ownerId, { title: "On track trip" });
    await addFlightToTrip(trip.id, ownerId, {
      flightNumber: "ET602",
      airline: "Ethiopian Airlines",
      departureAirport: "ADD",
      arrivalAirport: "DXB",
      scheduledDeparture: new Date("2026-09-10T08:00:00Z"),
      scheduledArrival: new Date("2026-09-10T13:30:00Z"),
    });
    const state = await calculateOperationalState(trip.id, ownerId);
    expect(state.state).toBe("ON_TRACK");
  });

  it("returns ATTENTION_NEEDED when the latest snapshot for a flight is DELAYED", async () => {
    const trip = await createTrip(ownerId, { title: "Delayed trip" });
    const flight = await addFlightToTrip(trip.id, ownerId, {
      flightNumber: "ET602",
      airline: "Ethiopian Airlines",
      departureAirport: "ADD",
      arrivalAirport: "DXB",
      scheduledDeparture: new Date("2026-09-10T08:00:00Z"),
      scheduledArrival: new Date("2026-09-10T13:30:00Z"),
    });
    await pool.query(
      `INSERT INTO flight_status_snapshots (flight_record_id, status, delay_minutes, fetched_at)
       VALUES ($1, 'DELAYED', 45, now())`,
      [flight.id],
    );

    const state = await calculateOperationalState(trip.id, ownerId);
    expect(state.state).toBe("ATTENTION_NEEDED");
    expect(state.factors[0]).toContain("45 minutes");
  });

  it("returns DISRUPTED when the latest snapshot is CANCELLED, even if an earlier one was fine", async () => {
    const trip = await createTrip(ownerId, { title: "Cancelled trip" });
    const flight = await addFlightToTrip(trip.id, ownerId, {
      flightNumber: "ET602",
      airline: "Ethiopian Airlines",
      departureAirport: "ADD",
      arrivalAirport: "DXB",
      scheduledDeparture: new Date("2026-09-10T08:00:00Z"),
      scheduledArrival: new Date("2026-09-10T13:30:00Z"),
    });
    // Append-only history: an earlier good snapshot, then a later bad
    // one -- proves the calculation reads the LATEST, not just any row.
    await pool.query(
      `INSERT INTO flight_status_snapshots (flight_record_id, status, fetched_at)
       VALUES ($1, 'SCHEDULED', now() - interval '2 hours')`,
      [flight.id],
    );
    await pool.query(
      `INSERT INTO flight_status_snapshots (flight_record_id, status, fetched_at)
       VALUES ($1, 'CANCELLED', now())`,
      [flight.id],
    );

    const state = await calculateOperationalState(trip.id, ownerId);
    expect(state.state).toBe("DISRUPTED");
  });
});

describe("getTripDigitalTwin", () => {
  it("assembles the full twin: trip, travelers, destinations, flights, documents, operational state", async () => {
    const trip = await createTrip(ownerId, { title: "Full twin test" });
    await addTravelerToTrip(trip.id, ownerId, { fullName: "Alice" });
    await addDestinationToTrip(trip.id, ownerId, { city: "Dubai", country: "UAE" });
    await addFlightToTrip(trip.id, ownerId, {
      flightNumber: "ET602",
      airline: "Ethiopian Airlines",
      departureAirport: "ADD",
      arrivalAirport: "DXB",
      scheduledDeparture: new Date("2026-09-10T08:00:00Z"),
      scheduledArrival: new Date("2026-09-10T13:30:00Z"),
    });

    const twin = await getTripDigitalTwin(trip.id, ownerId);
    expect(twin.trip.title).toBe("Full twin test");
    expect(twin.travelers).toHaveLength(1);
    expect(twin.destinations).toHaveLength(1);
    expect(twin.flights).toHaveLength(1);
    expect(twin.documents).toHaveLength(0); // genuinely empty, not stubbed -- no upload happened
    expect(twin.operationalState.state).toBe("ON_TRACK");
  });
});
