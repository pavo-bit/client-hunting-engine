-- T-002 migration 3/6: research runs, snapshots, evidence ledger.
-- Snapshots store metadata + short excerpt only (no unbounded content archive).
-- Reliability (source) and credibility (information) are separate columns.

create table public.research_run (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'queued' check (status in (
    'queued', 'running', 'ok', 'partial', 'failed'
  )),
  failure_class text check (failure_class in (
    'rate_limited', 'auth', 'terms_block', 'parse',
    'network', 'injection_suspect', 'validation', 'other'
  )),
  attempts integer not null default 1 check (attempts >= 1),
  note text,
  created_at timestamptz not null default now()
);
create index research_run_company_idx on public.research_run (company_id);

create table public.snapshot (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id) on delete cascade,
  source_key text not null references public.source (key) on delete restrict,
  research_run_id uuid references public.research_run (id) on delete set null,
  url text not null check (char_length(url) between 1 and 2000),
  fetched_at timestamptz not null default now(),
  sha256 char(64) not null check (sha256 ~ '^[0-9a-f]{64}$'),
  store_ref text,
  content_excerpt text check (content_excerpt is null or octet_length(content_excerpt) <= 2000),
  retention_class text not null check (retention_class in (
    'registry', 'directory', 'page', 'social', 'manual'
  )),
  suppressed boolean not null default false,
  created_at timestamptz not null default now()
);
create index snapshot_company_fetched_idx on public.snapshot (company_id, fetched_at);

-- Snapshots are immutable except the takedown/suppression flag (false -> true only).
create or replace function public.t002_guard_snapshot_mutation()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'snapshot rows are immutable (audit trail)';
  end if;
  if new.suppressed is distinct from old.suppressed then
    if old.suppressed = false and new.suppressed = true
       and new.id = old.id
       and new.company_id = old.company_id
       and new.source_key = old.source_key
       and new.research_run_id is not distinct from old.research_run_id
       and new.url = old.url
       and new.fetched_at = old.fetched_at
       and new.sha256 = old.sha256
       and new.store_ref is not distinct from old.store_ref
       and new.content_excerpt is not distinct from old.content_excerpt
       and new.retention_class = old.retention_class
       and new.created_at = old.created_at then
      return new; -- takedown suppression permitted
    end if;
  end if;
  raise exception 'snapshot rows are immutable except takedown suppression';
end;
$$;

create trigger snapshot_immutable
  before update or delete on public.snapshot
  for each row execute function public.t002_guard_snapshot_mutation();

-- Evidence ledger: one claim -> at least one snapshot (provenance mandatory).
create table public.claim (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id) on delete cascade,
  snapshot_id uuid not null references public.snapshot (id) on delete restrict,
  claim_text text not null check (char_length(claim_text) between 1 and 2000),
  claim_status text not null check (claim_status in (
    'observed', 'corroborated', 'inferred', 'assumed'
  )),
  source_reliability char(1) not null check (source_reliability in ('A', 'B', 'C', 'D')),
  info_credibility smallint not null check (info_credibility between 1 and 5),
  observed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  constraint claim_expiry_after_observed check (
    expires_at is null or observed_at is null or expires_at > observed_at
  )
);
create index claim_company_status_idx on public.claim (company_id, claim_status);
create index claim_snapshot_idx on public.claim (snapshot_id);
