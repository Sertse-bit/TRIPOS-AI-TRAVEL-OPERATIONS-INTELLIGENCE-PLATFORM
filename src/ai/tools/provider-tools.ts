import { z } from "zod";
import { defineTool } from "@/ai/tools/types";
import { NotFoundError } from "@/shared/errors";
import { getTrip } from "@/modules/trip/trip-service";
import { findFlightById } from "@/modules/trip/flight-repository";
import { findDestinationById } from "@/modules/trip/destination-repository";
import { getAviationProvider } from "@/integrations/aviation/provider";
import { getWeatherProvider } from "@/integrations/weather/provider";
import { getCurrencyProvider } from "@/integrations/currency/provider";
import { getSearchProvider } from "@/integrations/search/provider";

export const getFlightStatusTool = defineTool({
  name: "get_flight_status",
  description:
    "Get the current live status of a specific flight already added to a trip (scheduled, delayed, cancelled, etc.), sourced from a real aviation data provider. Requires the flight's ID from get_trip's flight list -- this does not accept a bare flight number, since the flight must already belong to a trip you have access to.",
  inputSchema: z.object({
    tripId: z.string().uuid(),
    flightRecordId: z.string().uuid(),
  }),
  execute: async (input, context) => {
    // Verifies trip ownership first -- getFlightById alone would leak
    // whether a given flightRecordId exists at all to a caller who
    // doesn't own the trip it belongs to.
    await getTrip(input.tripId, context.userId);

    const flight = await findFlightById(input.flightRecordId);
    if (!flight || flight.tripId !== input.tripId) {
      throw new NotFoundError("Flight", input.flightRecordId);
    }

    const status = await getAviationProvider().getFlightStatus(flight.flightNumber);
    return { flight: { id: flight.id, flightNumber: flight.flightNumber }, status };
  },
});

export const getWeatherTool = defineTool({
  name: "get_weather",
  description:
    "Get current weather conditions for a destination already added to a trip, sourced from a real weather data provider. Requires the destination's ID from get_trip's destination list.",
  inputSchema: z.object({
    tripId: z.string().uuid(),
    destinationId: z.string().uuid(),
  }),
  execute: async (input, context) => {
    await getTrip(input.tripId, context.userId);

    const destination = await findDestinationById(input.destinationId);
    if (!destination || destination.tripId !== input.tripId) {
      throw new NotFoundError("Destination", input.destinationId);
    }

    const weather = await getWeatherProvider().getCurrentWeather(
      `${destination.city}, ${destination.country}`,
    );
    return { destination: { id: destination.id, city: destination.city }, weather };
  },
});

export const getCurrencyRateTool = defineTool({
  name: "get_currency_rate",
  description:
    "Get the current exchange rate between two currencies, sourced from a real financial data provider (with automatic fallback to a second provider if the first is unavailable).",
  inputSchema: z.object({
    tripId: z.string().uuid(),
    baseCurrency: z.string().length(3, "Use a 3-letter ISO currency code, e.g. USD.").toUpperCase(),
    targetCurrency: z
      .string()
      .length(3, "Use a 3-letter ISO currency code, e.g. USD.")
      .toUpperCase(),
  }),
  execute: async (input, context) => {
    // Trip-scoped for a consistent authorization model across every
    // tool, even though an exchange rate itself isn't private data --
    // see docs/AI_ARCHITECTURE.md for why every tool ties back to a trip.
    await getTrip(input.tripId, context.userId);
    return getCurrencyProvider().getExchangeRate(input.baseCurrency, input.targetCurrency);
  },
});

export const searchDestinationTool = defineTool({
  name: "search_destination",
  description:
    "Search the web for information about a destination or travel-related question (e.g. visa requirements, local customs, safety advisories). Returns titles, URLs, and snippets -- always cite the source when using this information, never present it as verified fact without the source.",
  inputSchema: z.object({
    tripId: z.string().uuid(),
    query: z.string().trim().min(1).max(500),
  }),
  execute: async (input, context) => {
    await getTrip(input.tripId, context.userId);
    const results = await getSearchProvider().search(input.query);
    return { query: input.query, results };
  },
});
