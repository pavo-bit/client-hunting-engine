-- T-002 migration 4/6: hypotheses, capability catalog, project options.
-- Internal-operation hypotheses stay below 'validated' until human-led confirmation
-- (enforced in app + review; schema records status honestly, never auto-promotes).

create table public.hypothesis (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 300),
  opportunity_category text not null check (opportunity_category in (
    'integrations', 'automation_workflows', 'portals_dashboards',
    'testing_qa', 'reporting_analytics', 'ecommerce_tooling',
    'mobile_delivery', 'other_digital'
  )),
  status text not null default 'proposed' check (status in (
    'proposed', 'evidenced', 'validated', 'rejected', 'stale'
  )),
  confidence_rationale text,
  rejection_reason text,
  validated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hypothesis_rejection_needs_reason check (
    (status = 'rejected' and rejection_reason is not null)
    or status <> 'rejected'
  )
);
create index hypothesis_company_status_idx on public.hypothesis (company_id, status);

-- Claim links with polarity; same-company membership enforced by trigger.
create table public.hypothesis_evidence (
  hypothesis_id uuid not null references public.hypothesis (id) on delete cascade,
  claim_id uuid not null references public.claim (id) on delete restrict,
  polarity text not null check (polarity in ('supports', 'contradicts')),
  note text,
  created_at timestamptz not null default now(),
  primary key (hypothesis_id, claim_id)
);
create index hypothesis_evidence_claim_idx on public.hypothesis_evidence (claim_id);

create or replace function public.t002_guard_hypothesis_evidence_company()
returns trigger
language plpgsql
as $$
declare
  h_company uuid;
  c_company uuid;
begin
  select company_id into h_company from public.hypothesis where id = new.hypothesis_id;
  select company_id into c_company from public.claim where id = new.claim_id;
  if h_company is null or c_company is null or h_company <> c_company then
    raise exception 'hypothesis_evidence must link one company (hypothesis %, claim %)', new.hypothesis_id, new.claim_id;
  end if;
  return new;
end;
$$;

create trigger hypothesis_evidence_same_company
  before insert or update on public.hypothesis_evidence
  for each row execute function public.t002_guard_hypothesis_evidence_company();

-- Grayscales capability catalog. Rows seeded here are PLACEHOLDERS (D-004 open);
-- is_placeholder=true forbids presenting them as proven offerings.
create table public.capability (
  key text primary key check (char_length(key) between 1 and 120),
  name text not null check (char_length(name) between 1 and 200),
  description text,
  entry_criteria text,
  owner text,
  is_placeholder boolean not null default true,
  created_at timestamptz not null default now()
);

-- Scoped project proposal: ranges + assumptions, never point promises.
create table public.project_option (
  id uuid primary key default gen_random_uuid(),
  hypothesis_id uuid not null references public.hypothesis (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 300),
  scope_in text,
  scope_out text,
  milestones text,
  effort_lo_days integer check (effort_lo_days is null or effort_lo_days >= 0),
  effort_hi_days integer check (effort_hi_days is null or effort_hi_days >= 0),
  feasibility text not null check (feasibility in ('high', 'medium', 'low', 'unknown')),
  capability_fit text,
  assumptions text not null check (char_length(assumptions) between 1 and 4000),
  impact_note text,
  cost_low numeric(12, 2) check (cost_low is null or cost_low >= 0),
  cost_high numeric(12, 2) check (cost_high is null or cost_high >= 0),
  cost_currency char(3) check (cost_currency is null or cost_currency = upper(cost_currency)),
  dependencies text,
  validation_questions text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_effort_range check (
    effort_lo_days is null or effort_hi_days is null or effort_lo_days <= effort_hi_days
  ),
  constraint project_cost_range check (
    (cost_low is null and cost_high is null and cost_currency is null)
    or (cost_low is not null and cost_high is not null and cost_low <= cost_high)
  )
);
create index project_option_hypothesis_idx on public.project_option (hypothesis_id);

create table public.project_capability (
  project_option_id uuid not null references public.project_option (id) on delete cascade,
  capability_key text not null references public.capability (key) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (project_option_id, capability_key)
);

create trigger hypothesis_set_updated_at
  before update on public.hypothesis
  for each row execute function public.t002_set_updated_at();

create trigger project_option_set_updated_at
  before update on public.project_option
  for each row execute function public.t002_set_updated_at();
