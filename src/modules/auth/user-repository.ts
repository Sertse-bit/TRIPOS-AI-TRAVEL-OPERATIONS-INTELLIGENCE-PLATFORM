import { pool } from "@/infrastructure/db";

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  role: "USER" | "ADMIN";
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function mapRow(row: {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: "USER" | "ADMIN";
  email_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    name: row.name,
    role: row.role,
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createUser(input: {
  email: string;
  passwordHash: string;
  name: string;
}): Promise<UserRecord> {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, $2, $3)
     RETURNING id, email, password_hash, name, role, email_verified_at, created_at, updated_at`,
    [input.email.toLowerCase().trim(), input.passwordHash, input.name],
  );
  return mapRow(result.rows[0]);
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const result = await pool.query(
    `SELECT id, email, password_hash, name, role, email_verified_at, created_at, updated_at
     FROM users WHERE email = $1`,
    [email.toLowerCase().trim()],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  const result = await pool.query(
    `SELECT id, email, password_hash, name, role, email_verified_at, created_at, updated_at
     FROM users WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}
