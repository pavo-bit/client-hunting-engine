-- Migration M17: Phase 2 qualification content tables (Part 2).
--
-- Forward-only. Adds Phase-2-owned tables only; nothing Discovery owns is
-- altered except ADDITIVE nullable columns on p2.case_assessment and one
-- widened CHECK on p2.reference_version (existing rows untouched).
--
-- CONTENT VS LIFECYCLE: these tables hold versioned CONTENT (policy text,
-- service definitions, rubrics, capacity). Lifecycle (draft/active/retired)
-- lives ONLY in p2.reference_version — the cross-kind registry Part 1 built.
-- Nothing here is active on arrival: publication is an explicit operator act
-- (register + activate), and with O10/D-004/D-006/O7 all OPEN there is
-- deliberately no approved production content in this migration — no invented
-- defaults. Tests register their own fixture versions in the test database.
--
-- OWNERSHIP: all tables live in p2. No foreign key points into public.* —
-- Phase 2 links by stored stable identifiers and detects drift by
-- reconciliation (Part 1 rule, unchanged).

-- Scoring policy content: gate order/precedence, weights, floors, bands,
-- timing decay, ranking strategy, capacity handling, signal maps. Validated
-- structurally by lib/qualification/policy.ts before insert.
create table p2.scoring_policy (
  policy_version text primary key check (char_length(policy_version) between 1 and 80),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  recorded_by text not null check (char_length(recorded_by) between 1 and 200),
  recorded_at timestamptz not null default now()
);

-- Service catalog content: one row per service per catalog version.
-- Per-service status (draft/blocked/approved/retired) is IN the definition:
-- a service the owner has not supplied stays draft/blocked and can never be
-- published as approved (lib refuses; only approved services in an ACTIVE
-- catalog version are usable).
create table p2.service_catalog (
  catalog_version text not null check (char_length(catalog_version) between 1 and 80),
  service_id text not null check (char_length(service_id) between 1 and 80),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  recorded_by text not null check (char_length(recorded_by) between 1 and 200),
  recorded_at timestamptz not null default now(),
  primary key (catalog_version, service_id)
);
create index p2_service_catalog_version_idx on p2.service_catalog (catalog_version);

-- Dimension rubrics: range, inputs, missing-data semantics, evidence rules
-- per dimension. The scorer reads these; it contains no weights.
create table p2.rubric (
  rubric_version text primary key check (char_length(rubric_version) between 1 and 80),
  dimensions jsonb not null check (jsonb_typeof(dimensions) = 'object'),
  recorded_by text not null check (char_length(recorded_by) between 1 and 200),
  recorded_at timestamptz not null default now()
);

-- Capacity profile: pursuit bandwidth. Affects pursuit ORDER only, never
-- intrinsic fit (enforced in lib/qualification/scoring.ts, tested).
create table p2.capacity_profile (
  capacity_version text primary key check (char_length(capacity_version) between 1 and 80),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  recorded_by text not null check (char_length(recorded_by) between 1 and 200),
  recorded_at timestamptz not null default now()
);

-- Source trust registry: which sources may influence scoring, at what grade,
-- and which independence group they belong to. Absent row = unapproved =
-- excluded from scoring inputs (fail closed). Grades: A verified registry /
-- official record; B established directory or press; C unverified or
-- user-generated (usable only when explicitly approved AND labelled);
-- D untrusted (never approved).
create table p2.source_trust (
  source_key text primary key check (char_length(source_key) between 1 and 120),
  trust_grade text not null check (trust_grade in ('A', 'B', 'C', 'D')),
  approved_for_scoring boolean not null default false,
  independence_group text not null check (char_length(independence_group) between 1 and 120),
  notes text,
  updated_by text not null check (char_length(updated_by) between 1 and 200),
  updated_at timestamptz not null default now(),
  check (trust_grade <> 'D' or approved_for_scoring = false)
);

-- Research tasks: decision-relevant unanswered questions. Proposed by scoring
-- (status open), worked by the operator (accepted/done/dismissed). Never
-- executed automatically — Part 3 owns the research experience; this is the
-- prioritized foundation only.
create table p2.research_task (
  task_id uuid primary key default gen_random_uuid(),
  case_id uuid not null references p2.case (case_id) on delete cascade,
  snapshot_id uuid not null references p2.case_snapshot (snapshot_id),
  question text not null check (char_length(question) between 1 and 2000),
  reason_code text not null check (char_length(reason_code) between 1 and 80),
  dimension text check (dimension is null or char_length(dimension) between 1 and 80),
  gate text check (gate is null or char_length(gate) between 1 and 80),
  evidence_needed text not null check (char_length(evidence_needed) between 1 and 2000),
  expected_impact text not null check (expected_impact in ('high', 'medium', 'low')),
  uncertainty text not null check (char_length(uncertainty) between 1 and 2000),
  source_availability text not null check (char_length(source_availability) between 1 and 2000),
  effort_estimate text not null check (effort_estimate in ('low', 'medium', 'high')),
  priority_explanation text not null check (char_length(priority_explanation) between 1 and 2000),
  status text not null default 'open' check (status in ('open', 'accepted', 'done', 'dismissed')),
  operator_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index p2_research_task_case_idx on p2.research_task (case_id, status);

create trigger p2_research_task_set_updated_at
  before update on p2.research_task
  for each row execute function public.t002_set_updated_at();

-- Negative findings: what was searched, where, when and how. A negative
-- search is evidence, not absence of evidence — recorded, never inferred.
create table p2.negative_finding (
  finding_id uuid primary key default gen_random_uuid(),
  case_id uuid not null references p2.case (case_id) on delete cascade,
  snapshot_id uuid not null references p2.case_snapshot (snapshot_id),
  question text not null check (char_length(question) between 1 and 2000),
  searched_where text not null check (char_length(searched_where) between 1 and 2000),
  searched_at timestamptz not null,
  method text not null check (char_length(method) between 1 and 2000),
  actor text not null check (char_length(actor) between 1 and 200),
  created_at timestamptz not null default now()
);
create index p2_negative_finding_case_idx on p2.negative_finding (case_id);

-- Reproducible ranking snapshots: the ordered output of one ranking run with
-- its full input identity. Re-running identical inputs reproduces the hash.
create table p2.ranking_snapshot (
  ranking_id uuid primary key default gen_random_uuid(),
  policy_version text not null check (char_length(policy_version) between 1 and 80),
  catalog_version text not null check (char_length(catalog_version) between 1 and 80),
  rubric_version text not null check (char_length(rubric_version) between 1 and 80),
  capacity_version text check (capacity_version is null or char_length(capacity_version) between 1 and 80),
  as_of timestamptz not null,
  ordered jsonb not null check (jsonb_typeof(ordered) = 'array'),
  input_hash text not null check (char_length(input_hash) between 1 and 64),
  created_by text not null check (char_length(created_by) between 1 and 200),
  created_at timestamptz not null default now()
);

-- Capacity joins the reference lifecycle (existing rows untouched).
alter table p2.reference_version drop constraint reference_version_kind_check;
alter table p2.reference_version
  add constraint reference_version_kind_check
  check (kind in ('policy', 'service_catalog', 'rubric', 'schema', 'capacity'));

-- Assessments cite everything they were made under. service_catalog_version
-- (M10) carries the CATALOG version. All nullable: rows written before Part 2
-- stay valid and readable.
alter table p2.case_assessment
  add column capacity_version text check (capacity_version is null or char_length(capacity_version) between 1 and 80),
  add column as_of timestamptz,
  add column snapshot_hash text check (snapshot_hash is null or char_length(snapshot_hash) between 1 and 64),
  add column code_version text check (code_version is null or char_length(code_version) between 1 and 80);

alter table p2.scoring_policy enable row level security;
alter table p2.service_catalog enable row level security;
alter table p2.rubric enable row level security;
alter table p2.capacity_profile enable row level security;
alter table p2.source_trust enable row level security;
alter table p2.research_task enable row level security;
alter table p2.negative_finding enable row level security;
alter table p2.ranking_snapshot enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'p2_app') then
    grant usage on schema p2 to p2_app;
    grant insert on p2.scoring_policy, p2.service_catalog, p2.rubric,
                   p2.capacity_profile, p2.source_trust, p2.research_task,
                   p2.negative_finding, p2.ranking_snapshot to p2_app;
    grant select on p2.scoring_policy, p2.service_catalog, p2.rubric,
                    p2.capacity_profile, p2.source_trust, p2.research_task,
                    p2.negative_finding, p2.ranking_snapshot to p2_app;
    grant update (status, operator_notes) on p2.research_task to p2_app;
    grant update (trust_grade, approved_for_scoring, independence_group, notes) on p2.source_trust to p2_app;
    -- No DELETE anywhere (cases archive; research retires by status; trust
    -- rows are corrected, never removed).
  end if;
end;
$$;

create policy p2_content_p2app on p2.scoring_policy for all to p2_app using (true) with check (true);
create policy p2_catalog_p2app on p2.service_catalog for all to p2_app using (true) with check (true);
create policy p2_rubric_p2app on p2.rubric for all to p2_app using (true) with check (true);
create policy p2_capacity_p2app on p2.capacity_profile for all to p2_app using (true) with check (true);
create policy p2_trust_p2app on p2.source_trust for all to p2_app using (true) with check (true);
create policy p2_research_p2app on p2.research_task for all to p2_app using (true) with check (true);
create policy p2_negfinding_p2app on p2.negative_finding for all to p2_app using (true) with check (true);
create policy p2_ranking_p2app on p2.ranking_snapshot for all to p2_app using (true) with check (true);