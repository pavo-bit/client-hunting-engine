-- T-006 migration: discovery-run history + per-record source identity.
-- Additive. Observations stay distinct from canonical identity: runs record
-- what a source returned; companies are created only through the existing
-- intake path (validation + canonical uniques), conflicts route to review.

create table public.discovery_run (
  id uuid primary key default gen_random_uuid(),
  adapter_id text not null check (char_length(adapter_id) between 1 and 120),
  adapter_version text not null check (char_length(adapter_version) between 1 and 60),
  status text not null default 'running' check (status in (
    'queued', 'running', 'ok', 'partial', 'failed', 'cancelled'
  )),
  query_text text not null check (char_length(query_text) between 1 and 500),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  found integer not null default 0 check (found >= 0),
  created_new integer not null default 0 check (created_new >= 0),
  duplicates integer not null default 0 check (duplicates >= 0),
  skipped integer not null default 0 check (skipped >= 0),
  conflicts integer not null default 0 check (conflicts >= 0),
  failed_items integer not null default 0 check (failed_items >= 0),
  error text,
  created_by text not null check (char_length(created_by) between 1 and 200),
  constraint run_finished_needs_timestamp check (
    (status in ('running', 'queued')) or finished_at is not null
  )
);
create index discovery_run_adapter_idx on public.discovery_run (adapter_id, started_at);

-- Per-record outcome of a run (bounded; warnings are small string arrays).
create table public.discovery_run_item (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.discovery_run (id) on delete cascade,
  source_record_id text not null check (char_length(source_record_id) between 1 and 300),
  status text not null check (status in (
    'new', 'duplicate', 'skipped', 'invalid', 'conflict', 'failed'
  )),
  company_id uuid references public.company (id) on delete set null,
  candidate_id uuid references public.match_candidate (id) on delete set null,
  warnings jsonb not null default '[]' check (octet_length(warnings::text) <= 4000),
  note text,
  created_at timestamptz not null default now(),
  constraint discovery_run_item_uidx unique (run_id, source_record_id)
);
create index discovery_run_item_run_idx on public.discovery_run_item (run_id, status);

-- Stable per-source identity for idempotent reprocessing.
alter table public.discovery_record
  add column source_record_id text check (
    source_record_id is null or char_length(source_record_id) between 1 and 300
  );

create unique index discovery_record_source_uidx
  on public.discovery_record (source_key, source_record_id)
  where source_key is not null and source_record_id is not null;

-- Register the live source in the policy registry (authoritative LEI data).
insert into public.source (key, category, platform, reliability_prior, enabled)
values ('gleif-api', 'S-02', 'GLEIF LEI Index (api.gleif.org)', 'A', true)
on conflict (key) do nothing;

alter table public.discovery_run enable row level security;
alter table public.discovery_run_item enable row level security;
revoke all on public.discovery_run from public;
revoke all on public.discovery_run_item from public;
