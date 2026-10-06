import { withApiHandler, type RouteContext } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import { uploadTripDocument } from "@/modules/trip/document-service";
import { getTrip, getTripDocuments } from "@/modules/trip/trip-service";
import { ValidationError } from "@/shared/errors";
import { auditDocumentUploaded } from "@/modules/audit/route-audit";

export const GET = withApiHandler(async (_requestId, _log, _request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;

  return { documents: await getTripDocuments(id, user.id) };
});

/**
 * Accepts multipart/form-data with a single "file" field. The declared
 * Content-Type is only a claim — validateFileUpload sniffs the actual
 * magic bytes and rejects a mismatch, so the client can't get a JPEG
 * stored as a PDF by lying about its type.
 */
export const POST = withApiHandler(async (requestId, log, request, context: RouteContext) => {
  const user = await requireAuth();
  const { id } = await context.params;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    throw new ValidationError('Expected a multipart/form-data request with a "file" field.');
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new ValidationError('A document file is required in the "file" field.');
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const document = await uploadTripDocument(id, user.id, {
    buffer,
    filename: file.name,
    declaredMimeType: file.type,
  });
  const trip = await getTrip(id, user.id);
  auditDocumentUploaded({
    requestId,
    userId: user.id,
    trip,
    documentId: document.id,
    status: document.status,
  });

  log.info(
    { tripId: id, documentId: document.id, status: document.status },
    "Trip document uploaded",
  );
  return { document };
});
