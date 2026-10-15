-- Prompt 4 migration M3: versioned eligibility decisions (append-only).
-- Additive. Every evaluation appends a version row; rows are never updated
-- or deleted by application code (mirrors audit_log discipline; REVOKE
-- below removes write access from PUBLIC, owner path only).
-- The gate CONTENT evaluated here is caller-supplied until O10 blesses a
-- canonical set (see lib/discovery/eligibility.ts): this table stores
-- whatever explicit policy version + gates the caller asserts, so no
-- unapproved policy is baked into the schema. Forward-repair only.

create table public.opportunity_eligibility (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunity (id) on delete cascade,
  version integer not null check (version >= 1),
  decision text not null check (decision in ('eligible', 'ineligible', 'needs_info')),
  gate_reasons jsonb not null default '[]' check (octet_length(gate_reasons::text) <= 8000),
  policy_version text not null check (char_length(policy_version) between 1 and 120),
  decided_by text not null check (char_length(decided_by) between 1 and 200),
  decided_at timestamptz not null default now(),
  constraint opportunity_eligibility_version_uidx unique (opportunity_id, version)
);
-- No separate index: the unique constraint already indexes (opportunity_id,
-- version), which is also the history-read order.

alter table public.opportunity_eligibility enable row level security;
revoke all on public.opportunity_eligibility from public;
