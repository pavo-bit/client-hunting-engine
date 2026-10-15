-- Prompt 5 migration M7: identity-conflict review artifact.
-- Additive, forward-repair only.
--
-- Why: a discovery record whose (registry, country) or domain collides with an
-- existing canonical company is REFUSED from becoming a company (canonical
-- uniques, D-011). Until now the conflicting record's identity attributes were
-- dropped entirely - the run counted a conflict, wrote a note, and queued
-- nothing. match_candidate cannot help: it needs two company rows and the
-- second one must never be created here (that would be an undecided merge).
--
-- What this table is: an append-only capture of what the source said, waiting
-- for a human. What it is NOT: a merge, a duplicate company, an assertion of
-- identity. Nothing here references a second company, and no code path sets a
-- merged_into as a result of a row in this table.

create table public.identity_conflict (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.discovery_run (id) on delete cascade,
  -- Stable (source, record) identity of the observation that conflicted.
  source_record_id text not null check (char_length(source_record_id) between 1 and 300),
  -- The EXISTING canonical company the observation collides with.
  company_id uuid not null references public.company (id) on delete restrict,
  -- What the source claimed, verbatim. Never merged into company fields.
  observed_name text check (observed_name is null or char_length(observed_name) between 1 and 300),
  observed_domain text check (observed_domain is null or char_length(observed_domain) between 1 and 300),
  observed_registry_id text check (observed_registry_id is null or char_length(observed_registry_id) between 1 and 300),
  observed_country_code text check (observed_country_code is null or char_length(observed_country_code) between 2 and 8),
  -- Rule that fired, for operator triage (registry_scoped | domain_exact).
  rule text not null check (rule in ('registry_scoped', 'domain_exact')),
  detail text not null check (char_length(detail) between 1 and 2000),
  status text not null default 'pending' check (status in ('pending', 'reviewed', 'deferred')),
  decided_by text check (decided_by is null or char_length(decided_by) between 1 and 200),
  decided_at timestamptz,
  decision_reason text check (decision_reason is null or char_length(decision_reason) between 1 and 2000),
  created_at timestamptz not null default now(),
  -- One row per observed record per run: reruns are idempotent.
  constraint identity_conflict_uniq unique (run_id, source_record_id),
  constraint identity_conflict_decision_needs_actor check (
    (status = 'pending') or (decided_by is not null and decided_at is not null)
  )
);

create index identity_conflict_company_idx on public.identity_conflict (company_id, status);
create index identity_conflict_status_idx on public.identity_conflict (status, created_at desc);

alter table public.identity_conflict enable row level security;
revoke all on public.identity_conflict from public;