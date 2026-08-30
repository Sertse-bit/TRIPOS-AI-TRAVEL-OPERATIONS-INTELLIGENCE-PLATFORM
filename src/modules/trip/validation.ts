import { z } from "zod";

export const createTripSchema = z.object({
  title: z.string().trim().min(1, "Title is required.").max(200),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
});

export const updateTripSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
});

export const changeTripStatusSchema = z.object({
  status: z.enum(["PLANNING", "UPCOMING", "ACTIVE", "COMPLETED", "CANCELLED"]),
});

export const addTravelerSchema = z.object({
  fullName: z.string().trim().min(1, "Full name is required.").max(200),
  dateOfBirth: z.coerce.date().optional(),
  passportNumber: z.string().trim().max(50).optional(),
});

export const addDestinationSchema = z.object({
  city: z.string().trim().min(1, "City is required.").max(200),
  country: z.string().trim().min(1, "Country is required.").max(200),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  arrivalDate: z.coerce.date().optional(),
  departureDate: z.coerce.date().optional(),
  orderIndex: z.number().int().min(0).optional(),
});

export const addFlightSchema = z.object({
  flightNumber: z.string().trim().min(1).max(20),
  airline: z.string().trim().min(1).max(200),
  departureAirport: z.string().trim().length(3, "Use a 3-letter IATA airport code.").toUpperCase(),
  arrivalAirport: z.string().trim().length(3, "Use a 3-letter IATA airport code.").toUpperCase(),
  scheduledDeparture: z.coerce.date(),
  scheduledArrival: z.coerce.date(),
});
