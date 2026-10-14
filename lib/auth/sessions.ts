// AUTH-001: opaque server-side sessions in PostgreSQL (server-only).
//
// The cookie holds a raw 256-bit token (base64url). Only its SHA-256 hex
// digest is stored, so a database read alone cannot mint a session. Every
// validation enforces expiry + revocation server-side and applies a sliding
// refresh capped by an absolute maximum. All functions take an explicit pool
// (repo convention) and an explicit config (testability); route handlers pass
// getPool() + getAuthConfig().

import { createHash, randomBytes } from "crypto";
import type { Pool, PoolClient } from "pg";
import type { AuthConfig } from "./config";

export const SESSION_COOKIE = "gsid";

export interface OperatorSession {
  id: string;
  operatorEmail: string;
  createdAt: string;
  expiresAt: string;
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function newRawToken(): string {
  return randomBytes(32).toString("base64url");
}

function toSession(row: {
  id: string;
  operator_email: string;
  created_at: Date;
  expires_at: Date;
}): OperatorSession {
  return {
    id: row.id as string,
    operatorEmail: row.operator_email as string,
    createdAt: (row.created_at as Date).toISOString(),
    expiresAt: (row.expires_at as Date).toISOString(),
  };
}

async function audit(
  db: Pool | PoolClient,
  entityId: string,
  actor: string,
  from: string | null,
  to: string,
  reason: string,
): Promise<void> {
  // Auth events reuse the append-only audit_log. entity_id is the operator
  // email (attribution requires it); never tokens, hashes, or passwords.
  await db.query(
    `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
     values ('auth', $1, $2, $3, $4, $5)`,
    [entityId.slice(0, 300), actor.slice(0, 200), from, to, reason.slice(0, 2000)],
  );
}

/**
 * Create a fresh session for the operator. Revokes all prior sessions first
 * (single-operator tool: exactly one live session; also defeats fixation by
 * never reusing an identifier). Returns the RAW token - the only moment it
 * exists outside the cookie.
 */
export async function createSession(
  db: Pool,
  cfg: AuthConfig,
  operatorEmail: string,
): Promise<{ rawToken: string; session: OperatorSession }> {
  const raw = newRawToken();
  const digest = hashToken(raw);
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query(
      "update public.operator_session set revoked_at = now() where operator_email = $1 and revoked_at is null",
      [operatorEmail],
    );
    const r = await client.query(
      `insert into public.operator_session (token_hash, operator_email, expires_at)
       values ($1, $2, now() + make_interval(secs => $3))
       returning id, operator_email, created_at, expires_at`,
      [digest, operatorEmail, cfg.sessionTtlSec],
    );
    await audit(client, operatorEmail, operatorEmail, null, "login", "session created");
    // Opportunistic expiry purge keeps the table bounded without a scheduler.
    await client.query("delete from public.operator_session where expires_at < now() - interval '7 days'");
    await client.query("commit");
    const row = r.rows[0];
    return {
      rawToken: raw,
      session: toSession(row),
    };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Validate a raw cookie token. Returns the live session or null (expired,
 * revoked, unknown, or malformed - all indistinguishable to the caller).
 * Applies the sliding refresh, capped by the absolute maximum lifetime.
 */
export async function validateSession(
  db: Pool,
  cfg: AuthConfig,
  rawToken: string,
): Promise<OperatorSession | null> {
  if (!rawToken || rawToken.length < 16 || rawToken.length > 200) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(rawToken)) return null;
  const digest = hashToken(rawToken);
  const client = await db.connect();
  try {
    const r = await client.query(
      `select id, operator_email, created_at, expires_at
       from public.operator_session
       where token_hash = $1 and revoked_at is null`,
      [digest],
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    const now = new Date();
    if (new Date(row.expires_at as Date) <= now) {
      await client.query("update public.operator_session set revoked_at = now() where id = $1", [row.id]);
      await audit(client, row.operator_email as string, row.operator_email as string, "active", "expired", "session expired");
      return null;
    }
    // Sliding refresh, capped at created + max lifetime.
    const absoluteMax = new Date(new Date(row.created_at as Date).getTime() + cfg.sessionMaxSec * 1000);
    const next = new Date(Math.min(now.getTime() + cfg.sessionTtlSec * 1000, absoluteMax.getTime()));
    await client.query(
      "update public.operator_session set expires_at = $2, last_seen_at = now() where id = $1",
      [row.id, next.toISOString()],
    );
    return {
      id: row.id as string,
      operatorEmail: row.operator_email as string,
      createdAt: (row.created_at as Date).toISOString(),
      expiresAt: next.toISOString(),
    };
  } finally {
    client.release();
  }
}

/** Revoke one session (logout). Idempotent: unknown tokens still return true. */
export async function revokeSession(db: Pool, rawToken: string): Promise<boolean> {
  if (!rawToken || rawToken.length > 200) return true;
  const client = await db.connect();
  try {
    const r = await client.query(
      `update public.operator_session set revoked_at = now()
       where token_hash = $1 and revoked_at is null returning operator_email`,
      [hashToken(rawToken)],
    );
    if (r.rows.length > 0) {
      const email = r.rows[0].operator_email as string;
      await audit(client, email, email, "active", "logout", "session revoked by logout");
    }
    return true;
  } finally {
    client.release();
  }
}

/** Revoke every live session for the operator (rotation/recovery control). */
export async function revokeAllSessions(db: Pool, operatorEmail: string): Promise<number> {
  const r = await db.query(
    `update public.operator_session set revoked_at = now()
     where operator_email = $1 and revoked_at is null`,
    [operatorEmail],
  );
  return r.rowCount ?? 0;
}

/** Count live (unexpired, unrevoked) sessions - for tests and status checks. */
export async function countLiveSessions(db: Pool, operatorEmail: string): Promise<number> {
  const r = await db.query(
    `select count(*)::int as n from public.operator_session
     where operator_email = $1 and revoked_at is null and expires_at > now()`,
    [operatorEmail],
  );
  return r.rows[0].n as number;
}
