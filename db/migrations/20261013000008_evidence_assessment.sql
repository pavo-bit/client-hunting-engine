-- T-007 migration: claim assessment history, evidence links, review flags.
-- Additive. Canonical statuses gain verified/disputed/withdrawn/superseded
-- (stale stays computed from expires_at, never erasing). History is
-- append-only; corrections are superseding assessments, never rewrites.

-- 0. Event time on snapshots: when the observed event occurred (nullable),
-- distinct from fetched_at (capture time). Invariant: event / publish /
-- observe times stay distinguishable.
alter table public.snapshot
  add column observed_at timestamptz;

-- 1. Predicate/category on claims (nullable; suggested vocabulary documented).
alter table public.claim
  add column predicate text check (
    predicate is null or char_length(predicate) between 1 and 60
  );

-- 2. Review flag (human triage; orthogonal to status).
alter table public.claim
  add column needs_review boolean not null default false;

-- 3. Extended status vocabulary.
alter table public.claim drop constraint if exists claim_claim_status_check;
alter table public.claim
  add constraint claim_claim_status_check check (claim_status in (
    'observed', 'verified', 'corroborated', 'inferred', 'assumed',
    'disputed', 'withdrawn', 'superseded'
  ));

-- 4. Assessment history (append-only): who/what moved a claim, when, why.
create table public.claim_assessment (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claim (id) on delete cascade,
  from_status text,
  to_status text not null,
  rationale text not null check (char_length(rationale) between 1 and 2000),
  actor text not null check (char_length(actor) between 1 and 200),
  automatic boolean not null default false,
  created_at timestamptz not null default now()
);
create index claim_assessment_claim_idx on public.claim_assessment (claim_id, created_at);

create or replace function public.t007_guard_assessment_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'claim_assessment is append-only (INSERT + SELECT only)';
end;
$$;

create trigger claim_assessment_append_only
  before update or delete on public.claim_assessment
  for each row execute function public.t007_guard_assessment_append_only();

-- 5. Evidence links: a claim supported/contradicted/contextualized by an
--    observation (snapshot) or another claim — exactly one target each.
create table public.claim_evidence (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claim (id) on delete cascade,
  snapshot_id uuid references public.snapshot (id) on delete restrict,
  linked_claim_id uuid references public.claim (id) on delete cascade,
  polarity text not null check (polarity in ('supports', 'contradicts', 'contextual')),
  note text,
  created_by text not null check (char_length(created_by) between 1 and 200),
  created_at timestamptz not null default now(),
  constraint claim_evidence_single_target check (
    (snapshot_id is not null and linked_claim_id is null) or
    (snapshot_id is null and linked_claim_id is not null)
  ),
  constraint claim_evidence_no_self_link check (
    linked_claim_id is null or linked_claim_id <> claim_id
  )
);
create index claim_evidence_claim_idx on public.claim_evidence (claim_id, polarity);

alter table public.claim_assessment enable row level security;
alter table public.claim_evidence enable row level security;
revoke all on public.claim_assessment from public;
revoke all on public.claim_evidence from public;
