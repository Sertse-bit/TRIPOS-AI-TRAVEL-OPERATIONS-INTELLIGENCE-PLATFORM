import { pool } from "@/infrastructure/db";

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

function mapRow(row: {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export async function createSession(input: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<SessionRecord> {
  const result = await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id, user_id, token_hash, expires_at, revoked_at, created_at`,
    [input.userId, input.tokenHash, input.expiresAt],
  );
  return mapRow(result.rows[0]);
}

/**
 * Only returns a session that is both unexpired and unrevoked — callers
 * never need to remember to check both conditions themselves.
 */
export async function findActiveSessionByTokenHash(
  tokenHash: string,
): Promise<SessionRecord | null> {
  const result = await pool.query(
    `SELECT id, user_id, token_hash, expires_at, revoked_at, created_at
     FROM sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function revokeSessionByTokenHash(tokenHash: string): Promise<void> {
  await pool.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1`, [tokenHash]);
}

/** Used for "log out everywhere" — the concrete reason DB-backed sessions were chosen over JWT. */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}
