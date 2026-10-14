-- T-009 migration: proposal lifecycle, versioning, commercial evaluation.
-- Additive. project_option gains: review status, version chain, decision
-- provenance, pricing/tax/confidence/timeline fields, and the estimation
-- inputs + model version behind every range. History is immutable: decided
-- rows change status only through the decision path (app-enforced, tested);
-- new versions supersede rather than rewrite.

alter table public.project_option
  add column status text not null default 'draft' check (status in (
    'draft', 'in_review', 'needs_info', 'accepted', 'rejected',
    'superseded', 'archived'
  ));

alter table public.project_option
  add column version integer not null default 1 check (version >= 1);

alter table public.project_option
  add column decided_by text;

alter table public.project_option
  add column decided_at timestamptz;

alter table public.project_option
  add column decision_rationale text;

alter table public.project_option
  add column pricing_model text check (
    pricing_model is null or pricing_model in ('fixed_scope', 'time_and_materials', 'not_defined')
  );

alter table public.project_option
  add column tax_note text;

alter table public.project_option
  add column confidence text check (
    confidence is null or confidence in ('low', 'medium', 'high')
  );

alter table public.project_option
  add column timeline_lo_weeks integer check (timeline_lo_weeks is null or timeline_lo_weeks >= 0);

alter table public.project_option
  add column timeline_hi_weeks integer check (timeline_hi_weeks is null or timeline_hi_weeks >= 0);

alter table public.project_option
  add column estimate_inputs jsonb;

alter table public.project_option
  add column estimation_version text;

alter table public.project_option
  add column created_by text;

alter table public.project_option
  add constraint project_timeline_range check (
    timeline_lo_weeks is null or timeline_hi_weeks is null
    or timeline_lo_weeks <= timeline_hi_weeks
  );

-- One draft at a time per hypothesis (prevents draft pileup; versions chain).
create unique index project_option_draft_uidx
  on public.project_option (hypothesis_id)
  where status = 'draft';

-- Version numbers are unique per hypothesis.
create unique index project_option_version_uidx
  on public.project_option (hypothesis_id, version);
