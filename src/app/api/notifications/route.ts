import { z } from "zod";
import { withApiHandler } from "@/shared/api-response";
import { requireAuth } from "@/modules/auth/access-control";
import {
  countUnreadNotifications,
  findNotificationsByUserId,
  markNotificationRead,
} from "@/modules/notification/notification-service";

/** The caller's notifications, newest first, with an unread count. */
export const GET = withApiHandler(async () => {
  const user = await requireAuth();
  const [notifications, unread] = await Promise.all([
    findNotificationsByUserId(user.id),
    countUnreadNotifications(user.id),
  ]);
  return { notifications, unread };
});

const bodySchema = z.object({
  notificationId: z.string().uuid(),
});

/**
 * Marks one of the caller's own notifications as read. Returns
 * `updated: false` for a notification that doesn't exist, belongs to
 * someone else, or was already read — all three are the same answer, so
 * this can't be used to probe for other users' notification ids.
 */
export const PATCH = withApiHandler(async (_requestId, _log, request) => {
  const user = await requireAuth();
  const { notificationId } = bodySchema.parse(await request.json());
  const updated = await markNotificationRead(user.id, notificationId);
  return { updated };
});
