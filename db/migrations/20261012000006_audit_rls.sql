-- T-002 migration 6/6: audit trail, failure log, RLS baseline.
--
-- Authorization model (minimal defensible baseline, single-operator internal
-- tool; Docker + vanilla PostgreSQL — no Supabase roles):
--   * RLS is ENABLED on every application table (native PostgreSQL RLS).
--   * NO permissive policies are created: non-owner roles get zero access.
--   * Explicit REVOKE ALL ... FROM PUBLIC on every table (auditable here).
--   * The app talks to Postgres server-side with the owner connection
--     (DATABASE_URL), never from client code. Real secrets live in .env,
--     never committed (see .env.example).
--   * The unprivileged LOGIN role `noaccess` (created by scripts/db.mjs
--     bootstrap, CONNECT only, zero table grants) exists so tests can prove
--     denial for unauthorized roles.
--   * audit_log append-only is enforced by trigger for all table-granted roles.
--     LIMITATION (honest): table owners / superusers / anyone with DDL rights can
--     still alter or drop data. This is tamper-evidence for the app role, not
--     absolute immutability. See DATA_MODEL_AND_EVIDENCE.md.
-- Unresolved: operator login / multi-operator roles (no D-* decision yet);
-- non-local access stays disabled (localhost-only binding).

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (char_length(entity_type) between 1 and 120),
  entity_id text not null check (char_length(entity_id) between 1 and 300),
  actor text not null check (char_length(actor) between 1 and 200),
  transition_from text,
  transition_to text,
  reason text,
  created_at timestamptz not null default now()
);
create index audit_log_entity_idx on public.audit_log (entity_type, entity_id);

create or replace function public.t002_guard_audit_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only (INSERT + SELECT only)';
end;
$$;

create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function public.t002_guard_audit_append_only();

create table public.failure_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (char_length(entity_type) between 1 and 120),
  entity_id text,
  cause_class text not null check (cause_class in (
    'rate_limited', 'auth', 'terms_block', 'parse',
    'network', 'injection_suspect', 'validation', 'other'
  )),
  detail text,
  occurred_at timestamptz not null default now(),
  resolved boolean not null default false
);
create index failure_log_cause_idx on public.failure_log (cause_class, resolved);

-- RLS on: all T-002 tables. No policies -> default-deny for non-owners.
alter table public.company            enable row level security;
alter table public.company_alias      enable row level security;
alter table public.source             enable row level security;
alter table public.discovery_record   enable row level security;
alter table public.research_run       enable row level security;
alter table public.snapshot           enable row level security;
alter table public.claim              enable row level security;
alter table public.hypothesis         enable row level security;
alter table public.hypothesis_evidence enable row level security;
alter table public.capability         enable row level security;
alter table public.project_option     enable row level security;
alter table public.project_capability enable row level security;
alter table public.score_run          enable row level security;
alter table public.brief              enable row level security;
alter table public.outreach_draft     enable row level security;
alter table public.outcome_log        enable row level security;
alter table public.audit_log          enable row level security;
alter table public.failure_log        enable row level security;

-- Belt and braces: explicit REVOKE FROM PUBLIC so denial is auditable here.
-- (RLS default-deny already blocks non-owners; this makes it explicit.)
revoke all on public.company from public;
revoke all on public.company_alias from public;
revoke all on public.source from public;
revoke all on public.discovery_record from public;
revoke all on public.research_run from public;
revoke all on public.snapshot from public;
revoke all on public.claim from public;
revoke all on public.hypothesis from public;
revoke all on public.hypothesis_evidence from public;
revoke all on public.capability from public;
revoke all on public.project_option from public;
revoke all on public.project_capability from public;
revoke all on public.score_run from public;
revoke all on public.brief from public;
revoke all on public.outreach_draft from public;
revoke all on public.outcome_log from public;
revoke all on public.audit_log from public;
revoke all on public.failure_log from public;
