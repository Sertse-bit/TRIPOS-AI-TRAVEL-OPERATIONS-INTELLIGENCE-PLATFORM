// NOTE: this file is excluded from the main tsconfig.json typecheck scope
// (see "exclude") because @/generated/prisma doesn't exist until
// `prisma generate` has run successfully — blocked in this sandbox, see
// docs/DATABASE.md. It will typecheck normally wherever generate can run.
import { PrismaClient } from "@/generated/prisma";
import { randomBytes, scryptSync } from "node:crypto";

/**
 * Development/test seed data only — per the brief, never used to fake
 * production data. Run with `pnpm db:seed`.
 *
 * NOTE: this script uses the generated Prisma Client, which requires
 * `pnpm db:generate` to have run successfully first. In the sandbox this
 * work was built in, `prisma generate` could not execute (see
 * docs/DATABASE.md — Prisma's CLI needs network access to
 * binaries.prisma.sh, outside this sandbox's allowlist). This script is
 * the real, intended seed path for any normal environment with standard
 * internet access; it was not itself run end-to-end here. The equivalent
 * data shape *was* verified with raw SQL against the live local database
 * — see docs/DATABASE.md for that verification.
 */

const prisma = new PrismaClient();

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

async function main() {
  const user = await prisma.user.create({
    data: {
      email: "dev@tripos.local",
      passwordHash: hashPassword("dev-password-not-for-production"),
      name: "Dev User",
      role: "USER",
    },
  });

  const trip = await prisma.trip.create({
    data: {
      userId: user.id,
      title: "Addis Ababa to Dubai",
      status: "UPCOMING",
      startDate: new Date("2026-09-10"),
      endDate: new Date("2026-09-17"),
    },
  });

  const destination = await prisma.destination.create({
    data: {
      tripId: trip.id,
      city: "Dubai",
      country: "UAE",
      latitude: 25.2048,
      longitude: 55.2708,
      orderIndex: 0,
    },
  });

  const flight = await prisma.flightRecord.create({
    data: {
      tripId: trip.id,
      flightNumber: "ET602",
      airline: "Ethiopian Airlines",
      departureAirport: "ADD",
      arrivalAirport: "DXB",
      scheduledDeparture: new Date("2026-09-10T08:00:00Z"),
      scheduledArrival: new Date("2026-09-10T13:30:00Z"),
    },
  });

  await prisma.flightStatusSnapshot.create({
    data: {
      flightRecordId: flight.id,
      status: "SCHEDULED",
      fetchedAt: new Date(),
    },
  });

  await prisma.weatherSnapshot.create({
    data: {
      destinationId: destination.id,
      temperatureCelsius: 41.5,
      condition: "Sunny",
      windSpeedKph: 12.3,
      fetchedAt: new Date(),
    },
  });

  console.log(`Seeded 1 user, 1 trip (${trip.id}), 1 destination, 1 flight.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
