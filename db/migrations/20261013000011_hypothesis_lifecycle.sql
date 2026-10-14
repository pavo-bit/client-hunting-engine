-- T-008 migration: hypothesis lifecycle + rule traceability (additive).
-- Lifecycle becomes: generated / needs_review / deferred / rejected /
-- validated / superseded. Existing rows remapped (synthetic dev data):
--   proposed -> generated, evidenced/stale -> needs_review.
-- New columns record the deterministic rule, rationale, assumptions,
-- alternatives, missing info, questions, proposed intervention, and human
-- decisions. Evidence linkage reuses hypothesis_evidence (supports /
-- contradicts); project links reuse project_option.hypothesis_id.

-- Remap legacy statuses before tightening the vocabulary: the old check
-- must go FIRST, otherwise the remapping updates violate it themselves.
alter table public.hypothesis drop constraint if exists hypothesis_status_check;

-- Remap legacy statuses (synthetic dev data):
--   proposed -> generated, evidenced/stale -> needs_review.
update public.hypothesis set status = 'generated' where status = 'proposed';
update public.hypothesis set status = 'needs_review' where status in ('evidenced', 'stale');

alter table public.hypothesis
  add constraint hypothesis_status_check check (status in (
    'generated', 'needs_review', 'deferred', 'rejected', 'validated', 'superseded'
  ));

alter table public.hypothesis
  add column rule_id text check (
    rule_id is null or char_length(rule_id) between 1 and 80
  );

alter table public.hypothesis
  add column rule_version text check (
    rule_version is null or char_length(rule_version) between 1 and 20
  );

alter table public.hypothesis
  add column rationale text;

alter table public.hypothesis
  add column assumptions text;

alter table public.hypothesis
  add column alternatives text;

alter table public.hypothesis
  add column missing_info text;

alter table public.hypothesis
  add column validation_questions text;

alter table public.hypothesis
  add column intervention text;

alter table public.hypothesis
  add column decided_by text;

alter table public.hypothesis
  add column decided_at timestamptz;

alter table public.hypothesis
  add column decision_rationale text;

-- One open hypothesis per (company, rule): regeneration is idempotent.
create unique index hypothesis_open_rule_uidx
  on public.hypothesis (company_id, rule_id)
  where rule_id is not null and status in ('generated', 'needs_review', 'deferred');

create index hypothesis_company_status_idx2
  on public.hypothesis (company_id, status);
