import { notFound } from "next/navigation";
import { NotFoundError } from "@/shared/errors";

/**
 * Runs a server component's data load and turns the domain's
 * `NotFoundError` into Next's 404 response.
 *
 * Found by live verification during Phase 22: `/trips/[id]` and
 * `/trips/[id]/itinerary` returned a **500** for a trip id the session
 * does not own, because `requireOwnedTrip`'s `NotFoundError` escaped the
 * render instead of being translated. The API has had the correct
 * semantics since Phase 7 (that same error becomes a clean 404
 * envelope); the pages need the identical translation, in particular so
 * a non-owner's request is indistinguishable from a genuinely unknown
 * trip rather than a distinguishable 500.
 */
export async function orNotFound<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}
