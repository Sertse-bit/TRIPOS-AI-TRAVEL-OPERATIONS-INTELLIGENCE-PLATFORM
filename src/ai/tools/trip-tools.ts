import { z } from "zod";
import { defineTool } from "@/ai/tools/types";
import { getTripDigitalTwin, getTripDocuments } from "@/modules/trip/trip-service";

export const getTripTool = defineTool({
  name: "get_trip",
  description:
    "Get the full digital twin for a trip: trip details, travelers, destinations, flights, documents, and current operational state. Use this to answer any question about a specific trip's current setup or status.",
  inputSchema: z.object({
    tripId: z.string().uuid(),
  }),
  execute: async (input, context) => {
    return getTripDigitalTwin(input.tripId, context.userId);
  },
});

export const getTripDocumentsTool = defineTool({
  name: "get_trip_documents",
  description:
    "List the documents attached to a trip (filename, type, upload status). Does not return document content -- that requires search_trip_knowledge once documents have been processed.",
  inputSchema: z.object({
    tripId: z.string().uuid(),
  }),
  execute: async (input, context) => {
    const documents = await getTripDocuments(input.tripId, context.userId);
    return { documents };
  },
});
