import { pool } from "@/infrastructure/db";
import {
  type NotificationRecord,
  findNotificationsByUserId,
} from "@/modules/trip/notification-repository";

export type { NotificationRecord };
export { findNotificationsByUserId };

/**
 * Notification Service — Phase 18.
 *
 * Phase 8's `create_alert` tool could already write a notification; what
 * did not exist was any rule about *when one is warranted*. An automated
 * monitor runs on a schedule, so without a gate the same unchanged
 * condition would notify a traveler every few minutes. That is the
 * brief's "avoid notification spam" requirement.
 *
 * The gate is deliberately simple and explainable rather than clever: an
 * alert is written only when its `dedupeKey` has not already been used.
 * The dedupe key's UNIQUE index makes that an atomic, database-level
 * guarantee rather than a check-then-act race — two concurrent monitor
 * passes cannot both observe "not yet notified" and each send one.
 *
 * Ordering follows the schema's own shape: `notifications.trip_event_id`
 * points *at* a trip event, so the event is recorded first (with
 * ON CONFLICT DO NOTHING as the dedupe gate) and the notification is
 * only written if that insert actually claimed the key.
 */
export interface NotificationOutcome {
  notification: NotificationRecord | null;
  suppressed: boolean;
}

export async function createDeduplicatedNotification(input: {
  userId: string;
  tripId: string;
  entityType: string;
  entityId: string;
  title: string;
  body: string;
  /** The exact dedupe key claimed on the trip event, for the caller to report. */
  dedupeKey: string;
}): Promise<NotificationOutcome> {
  const claimed = await pool.query<{ id: string }>(
    `INSERT INTO trip_events (trip_id, event_type, entity_type, entity_id, metadata, dedupe_key)
     VALUES ($1, 'NOTIFICATION_REQUIRED', $2, $3, $4::jsonb, $5)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      input.tripId,
      input.entityType,
      input.entityId,
      JSON.stringify({ title: input.title, dedupeKey: input.dedupeKey }),
      input.dedupeKey,
    ],
  );

  // Someone already reported this exact condition — a true no-op, not
  // a duplicate alert.
  if (claimed.rows.length === 0) {
    return { notification: null, suppressed: true };
  }

  const eventId = claimed.rows[0].id;
  const inserted = await pool.query<{
    id: string;
    user_id: string;
    trip_event_id: string | null;
    title: string;
    body: string;
    read_at: Date | null;
    created_at: Date;
  }>(
    `INSERT INTO notifications (user_id, trip_event_id, title, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, trip_event_id, title, body, read_at, created_at`,
    [input.userId, eventId, input.title, input.body],
  );

  const row = inserted.rows[0];
  return {
    suppressed: false,
    notification: {
      id: row.id,
      userId: row.user_id,
      title: row.title,
      body: row.body,
      readAt: row.read_at,
      createdAt: row.created_at,
    },
  };
}

/** Mark one notification read. Scoped by user so nobody can read another's. */
export async function markNotificationRead(
  userId: string,
  notificationId: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE notifications SET read_at = now()
     WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
    [notificationId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function countUnreadNotifications(userId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId],
  );
  return result.rows[0].count;
}
