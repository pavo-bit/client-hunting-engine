-- T-002 migration 5/6: scoring, briefs, drafts (manual-only), outcomes.
-- Deterministic scoring: total is GENERATED from components (always consistent).
-- Bands use provisional thresholds (D-006); weight_version pins the rule set.
-- No send path: outreach_draft has no sent-at/sent-status columns BY DESIGN.

create table public.score_run (
  id uuid primary key default gen_random_uuid(),
  hypothesis_id uuid not null references public.hypothesis (id) on delete cascade,
  weight_version text not null default 'v0.1-PROVISIONAL'
    check (char_length(weight_version) between 1 and 60),
  fit integer not null check (fit >= 0),
  evidence integer not null check (evidence >= 0),
  opportunity integer not null check (opportunity >= 0),
  feasibility integer not null check (feasibility >= 0),
  timing integer not null check (timing >= 0),
  deductions integer not null default 0 check (deductions >= 0),
  total integer generated always as
    (fit + evidence + opportunity + feasibility + timing - deductions) stored,
  band char(1) generated always as (
    case
      when (fit + evidence + opportunity + feasibility + timing - deductions) >= 75 then 'A'
      when (fit + evidence + opportunity + feasibility + timing - deductions) >= 55 then 'B'
      when (fit + evidence + opportunity + feasibility + timing - deductions) >= 35 then 'C'
      else 'D'
    end
  ) stored,
  gates_passed boolean not null,
  gate_notes text,
  explanation jsonb not null check (octet_length(explanation::text) <= 8000),
  created_at timestamptz not null default now(),
  constraint score_gates_hold_when_ranked check (
    gates_passed = true or gate_notes is not null
  )
);
create index score_run_hypothesis_idx on public.score_run (hypothesis_id);

-- Frozen review package. brief rows reference inputs; hash recorded at freeze time.
create table public.brief (
  ref text primary key check (ref ~ '^BR-[0-9]{4}-[0-9]{3,}$'),
  company_id uuid not null references public.company (id) on delete cascade,
  hypothesis_id uuid not null references public.hypothesis (id) on delete restrict,
  score_run_id uuid references public.score_run (id) on delete set null,
  frozen_inputs_hash char(64) not null check (frozen_inputs_hash ~ '^[0-9a-f]{64}$'),
  markdown text not null check (char_length(markdown) between 1 and 60000),
  status text not null default 'draft' check (status in (
    'draft', 'in_review', 'approved', 'needs_work'
  )),
  reviewer text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index brief_company_idx on public.brief (company_id);

-- Outreach preparation is DRAFT-ONLY. is_human_send_only is pinned TRUE by
-- constraint; there is deliberately no sent_at / delivery_status / job table.
create table public.outreach_draft (
  id uuid primary key default gen_random_uuid(),
  brief_ref text not null references public.brief (ref) on delete cascade,
  channel text not null check (channel in ('email', 'dm', 'contact_form', 'note')),
  subject text,
  body text not null check (char_length(body) between 1 and 10000),
  is_human_send_only boolean not null default true check (is_human_send_only = true),
  created_at timestamptz not null default now()
);
create index outreach_draft_brief_idx on public.outreach_draft (brief_ref);

-- Manually recorded outcomes only. sent_at_manual documents a human act
-- performed outside the system; nothing here can trigger delivery.
create table public.outcome_log (
  id uuid primary key default gen_random_uuid(),
  brief_ref text not null references public.brief (ref) on delete restrict,
  sent_at_manual date,
  channel text check (channel in ('email', 'dm', 'contact_form', 'call', 'event', 'other')),
  outcome text not null check (outcome in (
    'no_reply', 'replied', 'meeting', 'proposal', 'won', 'lost'
  )),
  deal_range_note text,
  rejection_code text check (rejection_code in (
    'no_fit', 'no_budget', 'no_response', 'bad_timing',
    'competitor', 'chose_other', 'other'
  )),
  note text,
  recorded_by text not null check (char_length(recorded_by) between 1 and 200),
  created_at timestamptz not null default now()
);
create index outcome_log_brief_idx on public.outcome_log (brief_ref);

create trigger brief_set_updated_at
  before update on public.brief
  for each row execute function public.t002_set_updated_at();
