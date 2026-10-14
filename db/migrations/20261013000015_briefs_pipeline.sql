-- T-010 migration: briefs linked to proposals, pipeline, drafts lifecycle,
-- catalog approval states, outcome vocabulary. Additive.
--
-- Design notes:
-- - Briefs reference an accepted proposal (proposal_id) and freeze inputs
--   by hash. One active brief per proposal (partial unique). Statuses:
--   draft/in_review/approved/needs_info/rejected/superseded/archived
--   (legacy needs_work remapped to needs_info).
-- - Pipeline stages live on the brief (current) + pipeline_event history
--   (append-only-ish: no update/delete API, enforced app-side + tested).
-- - Drafts gain status/version/unverified-points; approval is blocked while
--   unverified points remain (server-enforced).
-- - Capability rows gain approval status; seed placeholders stay
--   needs_owner_review. Nothing here approves offerings.

-- 1. Capability approval states.
alter table public.capability
  add column status text not null default 'needs_owner_review' check (
    status in ('draft', 'needs_owner_review', 'approved')
  );

-- 2. Brief lifecycle + proposal link + pipeline fields.
update public.brief set status = 'needs_info' where status = 'needs_work';

alter table public.brief drop constraint if exists brief_status_check;
alter table public.brief
  add constraint brief_status_check check (status in (
    'draft', 'in_review', 'approved', 'needs_info', 'rejected',
    'superseded', 'archived'
  ));

alter table public.brief
  add column proposal_id uuid references public.project_option (id) on delete restrict;

alter table public.brief
  add column version integer not null default 1 check (version >= 1);

alter table public.brief
  add column decided_by text;

alter table public.brief
  add column decision_rationale text;

alter table public.brief
  add column pipeline_stage text check (
    pipeline_stage is null or pipeline_stage in (
      'research', 'qualified', 'ready_for_outreach', 'contacted',
      'responded', 'discovery', 'proposal_talk', 'won', 'lost',
      'disqualified', 'on_hold'
    )
  );

alter table public.brief
  add column next_action text;

alter table public.brief
  add column follow_up_date date;

-- One active brief per proposal (duplicate active opportunities prevented).
create unique index brief_active_proposal_uidx
  on public.brief (proposal_id)
  where proposal_id is not null
    and status in ('draft', 'in_review', 'needs_info', 'approved');

create index brief_pipeline_idx on public.brief (pipeline_stage)
  where pipeline_stage is not null;

-- 3. Pipeline stage history (write-once via API; no update/delete path).
create table public.pipeline_event (
  id uuid primary key default gen_random_uuid(),
  brief_ref text not null references public.brief (ref) on delete cascade,
  from_stage text,
  to_stage text not null check (to_stage in (
    'research', 'qualified', 'ready_for_outreach', 'contacted',
    'responded', 'discovery', 'proposal_talk', 'won', 'lost',
    'disqualified', 'on_hold'
  )),
  note text not null check (char_length(note) between 1 and 2000),
  next_action text,
  follow_up_date date,
  actor text not null check (char_length(actor) between 1 and 200),
  occurred_at timestamptz not null default now(),
  recorded_at timestamptz not null default now()
);
create index pipeline_event_brief_idx on public.pipeline_event (brief_ref, recorded_at);

-- 4. Outcome vocabulary: record observed outcomes incl. referral, meetings,
-- disqualification, hold, and directional responses. Still manual-only.
alter table public.outcome_log drop constraint if exists outcome_log_outcome_check;
alter table public.outcome_log
  add constraint outcome_log_outcome_check check (outcome in (
    'no_reply', 'replied', 'positive_response', 'negative_response',
    'referral', 'meeting', 'discovery_meeting', 'proposal', 'won', 'lost',
    'disqualified', 'on_hold'
  ));

-- 5. Draft lifecycle: status + versions + unverified-points gate.
alter table public.outreach_draft
  add column status text not null default 'draft' check (
    status in ('draft', 'in_review', 'ready')
  );

alter table public.outreach_draft
  add column version integer not null default 1 check (version >= 1);

alter table public.outreach_draft
  add column unverified_points text;

alter table public.outreach_draft
  add column decided_by text;

alter table public.outreach_draft
  add column decided_at timestamptz;

create unique index outreach_draft_version_uidx
  on public.outreach_draft (brief_ref, version);

alter table public.pipeline_event enable row level security;
revoke all on public.pipeline_event from public;
