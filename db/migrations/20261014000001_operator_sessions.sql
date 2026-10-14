-- AUTH-001 migration: server-side operator sessions (opaque, PostgreSQL-backed).
-- Additive only. No existing table, constraint, or seed row is touched.
--
-- Design:
--   * The cookie holds a raw 256-bit token (base64url). The table stores only
--     its SHA-256 hex digest, so a database read alone cannot mint a session.
--   * Expiry is enforced server-side on every validation (expires_at). Sliding
--     refresh is capped by created_at + max lifetime (application logic).
--   * Revocation is explicit (revoked_at). Expired/revoked rows authorize
--     nothing; a cleanup index supports opportunistic purging (no cron).
--   * Single-operator tool: operator_email is informational attribution, not a
--     multi-user model. No roles, no registration, no password storage here.

create table public.operator_session (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  operator_email text not null check (char_length(operator_email) between 3 and 320),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (expires_at > created_at),
  check (revoked_at is null or revoked_at >= created_at)
);

create index operator_session_expires_idx
  on public.operator_session (expires_at)
  where revoked_at is null;

-- Auth audit trail reuses the append-only audit_log (entity_type = 'auth').
-- No trigger change needed: INSERTs are allowed, UPDATE/DELETE stay blocked.

alter table public.operator_session enable row level security;
revoke all on public.operator_session from public;
