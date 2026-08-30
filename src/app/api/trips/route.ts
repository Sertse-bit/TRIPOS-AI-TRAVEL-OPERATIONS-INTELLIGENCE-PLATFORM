import { withApiHandler } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { createTrip, listUserTrips } from "@/modules/trip/trip-service";
import { createTripSchema } from "@/modules/trip/validation";

export const GET = withApiHandler(async () => {
  const user = await requireAuth();
  const trips = await listUserTrips(user.id);
  return { trips };
});

export const POST = withApiHandler(async (_requestId, log, request) => {
  const user = await requireAuth();
  const body = await request.json();
  const input = createTripSchema.parse(body);

  const trip = await createTrip(user.id, input);
  log.info({ tripId: trip.id }, "Trip created");
  return { trip };
});
