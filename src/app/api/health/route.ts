import { withApiHandler } from "@/shared/api-response";
import { providerAvailability } from "@/config/env";

export const GET = withApiHandler(async (requestId, log) => {
  log.info("Health check requested");

  return {
    status: "ok" as const,
    timestamp: new Date().toISOString(),
    requestId,
    // Real provider availability, derived from actual configured env vars —
    // never a hardcoded "all operational" (see brief: "Do not invent metrics").
    providers: providerAvailability,
  };
});
