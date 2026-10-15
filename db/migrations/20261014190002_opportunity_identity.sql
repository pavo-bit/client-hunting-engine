-- Prompt 4 migration M2: opportunity identity + business relationships.
-- Additive. Per-pipeline stable opportunity keys (amendment §4E); multiple
-- opportunities per business allowed (no per-company uniqueness).
-- Direct-client ROWS are forbidden at application level until O1 is decided
-- (see lib/discovery/opportunities.ts); the CHECK lists both values so no
-- second migration is needed whichever way O1 goes. Relationships are
-- display/review only: zero merge semantics, RESTRICT everywhere.
-- Forward-repair only (no down path).

create table public.opportunity (
  id uuid primary key default gen_random_uuid(),
  pipeline text not null check (pipeline in ('agency_partner', 'direct_client')),
  opportunity_key text not null check (char_length(opportunity_key) between 1 and 300),
  company_id uuid references public.company (id) on delete restrict,
  rule_id text check (rule_id is null or char_length(rule_id) between 1 and 80),
  status text not null default 'observed' check (status in (
    'observed', 'eligible', 'ineligible', 'promoted', 'stale', 'archived'
  )),
  solution_status text not null default 'unknown' check (solution_status in (
    'unknown', 'absent_evidence', 'present_confirmed', 'present_unverified'
  )),
  first_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opportunity_key_per_pipeline_uidx unique (pipeline, opportunity_key)
);
create index opportunity_pipeline_status_idx on public.opportunity (pipeline, status);
create index opportunity_company_idx on public.opportunity (company_id);

create table public.business_relationship (
  id uuid primary key default gen_random_uuid(),
  company_a uuid not null references public.company (id) on delete restrict,
  company_b uuid not null references public.company (id) on delete restrict,
  rel_type text not null check (rel_type in (
    'parent', 'subsidiary', 'alias_network', 'sibling'
  )),
  note text,
  created_at timestamptz not null default now(),
  check (company_a <> company_b)
);
create index business_relationship_company_idx on public.business_relationship (company_a, company_b);

-- updated_at maintenance follows repo convention (company/hypothesis/brief):
-- the trigger covers every writer, so lib code setting it explicitly is
-- harmless duplication, not a dependency.
create trigger opportunity_set_updated_at
  before update on public.opportunity
  for each row execute function public.t002_set_updated_at();

alter table public.opportunity enable row level security;
alter table public.business_relationship enable row level security;
revoke all on public.opportunity from public;
revoke all on public.business_relationship from public;
