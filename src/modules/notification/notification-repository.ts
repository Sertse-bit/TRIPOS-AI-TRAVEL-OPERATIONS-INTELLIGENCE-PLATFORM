import { pool } from "@/infrastructure/db";

export interface NotificationRecord {
  id: string;
  userId: string;
  title: string;
  body: string;
  readAt: Date | null;
  createdAt: Date;
}

function mapRow(row: {
  id: string;
  user_id: string;
  title: string;
  body: string;
  read_at: Date | null;
  created_at: Date;
}): NotificationRecord {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    body: row.body,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

/**
 * Basic create only — no throttling or dedup logic here, by design:
 * this repository persists one notification correctly when asked, and
 * the *policy* about when asking is warranted lives one layer up.
 *
 * That policy now exists. Phase 18's
 * `modules/notification/notification-service.ts` gates automated alerts
 * on a UNIQUE dedupe key, and Phase 19's Trip Watch decides *when* a
 * pass runs at all (with a per-trip severity floor). Anything writing a
 * notification for a condition that can repeat — i.e. anything a
 * schedule can trigger — should go through that service, not here.
 *
 * Phase 33 (Final Engineering Audit): moved here from
 * `modules/trip/`, where it had been living since Phase 8 even though it
 * touches no trip column. The notification module owns the concept, and
 * the audit's boundary check fails on a module reaching into another
 * module's repository — which this file was making the notification
 * service do. Nothing but the import path changed.
 */
export async function createNotification(input: {
  userId: string;
  title: string;
  body: string;
}): Promise<NotificationRecord> {
  const result = await pool.query(
    `INSERT INTO notifications (user_id, title, body)
     VALUES ($1, $2, $3)
     RETURNING id, user_id, title, body, read_at, created_at`,
    [input.userId, input.title, input.body],
  );
  return mapRow(result.rows[0]);
}

export async function findNotificationsByUserId(userId: string): Promise<NotificationRecord[]> {
  const result = await pool.query(
    `SELECT id, user_id, title, body, read_at, created_at
     FROM notifications WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows.map(mapRow);
}
