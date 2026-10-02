import { z } from "zod";
import { ITINERARY_ITEM_TYPES } from "./itinerary-repository";

/**
 * Validation schemas for the itinerary API (Phase 20), kept in the module
 * so the service and the HTTP routes share exactly one definition of what
 * a valid item is. Time format matches the CHECK constraint the database
 * enforces (prisma/sql/phase-20-itinerary-planner.sql).
 */

export const itineraryTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM time, e.g. 09:30.");

export const itineraryDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date.");

export const itineraryCurrencySchema = z
  .string()
  .trim()
  .length(3, "Use a 3-letter currency code, e.g. USD.")
  .toUpperCase();

export const addItineraryItemSchema = z
  .object({
    day: itineraryDaySchema,
    title: z.string().trim().min(1, "A title is required.").max(200),
    itemType: z.enum(ITINERARY_ITEM_TYPES).optional(),
    startTime: itineraryTimeSchema.optional(),
    endTime: itineraryTimeSchema.optional(),
    location: z.string().trim().max(300).optional(),
    destinationId: z.string().uuid().optional(),
    notes: z.string().trim().max(2000).optional(),
    estimatedCost: z.number().min(0).max(10_000_000).optional(),
    currency: itineraryCurrencySchema.optional(),
  })
  .refine(
    (value) => (value.estimatedCost === undefined) === (value.currency === undefined),
    "A cost and its currency must be provided together.",
  );

export type AddItineraryItemInput = z.infer<typeof addItineraryItemSchema>;

/**
 * Update accepts explicit nulls so a wrong cost, time, or note can be
 * cleared — distinct from the field being absent, which leaves it as-is.
 * The cost/currency pair is only enforced when either is present, since
 * clearing both at once (`null`/`null`) is legitimate.
 */
export const updateItineraryItemSchema = z
  .object({
    day: itineraryDaySchema.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    itemType: z.enum(ITINERARY_ITEM_TYPES).optional(),
    startTime: itineraryTimeSchema.nullable().optional(),
    endTime: itineraryTimeSchema.nullable().optional(),
    location: z.string().trim().max(300).nullable().optional(),
    destinationId: z.string().uuid().nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    estimatedCost: z.number().min(0).max(10_000_000).nullable().optional(),
    currency: itineraryCurrencySchema.nullable().optional(),
  })
  .refine((value) => {
    const costProvided = value.estimatedCost !== undefined;
    const currencyProvided = value.currency !== undefined;
    if (!costProvided && !currencyProvided) return true;
    if (costProvided !== currencyProvided) return false;
    // Both provided: either both clear (null) or both carry a real value.
    return (value.estimatedCost === null) === (value.currency === null);
  }, "A cost and its currency must be updated together.");

export const setTripBudgetSchema = z.object({
  amount: z.number().positive("A budget must be greater than zero.").max(10_000_000),
  currency: itineraryCurrencySchema,
});

export type SetTripBudgetInput = z.infer<typeof setTripBudgetSchema>;

/** Re-exported so callers don't import the repository just for the type list. */
export { ITINERARY_ITEM_TYPES };
export type { ItineraryItemType } from "./itinerary-repository";
