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
 * Basic create only — no throttling or dedup logic here. Phase 19 (Trip
 * Watch) is explicitly responsible for "avoid notification spam" at the
 * point where notifications are triggered by repeated automated checks;
 * this repository just needs to persist one correctly when asked.
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
