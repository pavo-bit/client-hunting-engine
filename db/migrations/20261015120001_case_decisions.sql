-- Migration M18: human decision records + research due flags (Part 3).
--
-- Forward-only. Adds Phase-2-owned objects only; nothing Discovery owns is
-- altered.
--
-- DECISIONS (p2.case_decision): the immutable human verdict on a case.
-- Vocabulary mapping (no duplicate statuses — the case workflow from M10 is
-- reused, decisions record what the human concluded):
--   accepted  -> case is pursued (maps the "Accepted" review state);
--   rejected  -> case is refused (maps "Rejected"; fit-refusals carry a
--                fit reason code, process-refusals another — same state);
--   deferred  -> decision postponed with a resume condition (maps "Deferred");
--   withdrawn -> case leaves pursuit, status moves to archived ("Withdrawn").
-- System-side states stay computed, not stored: NotAFit = latest gate
-- outcome not_eligible; Blocked/NeedsEvidence = gate outcomes;
-- AwaitingAssessment = discovered with no assessment; QualifiedForReview =
-- assessed with a fresh eligible assessment. The display derivation lives in
-- lib/qualification/decisions.ts (pure, tested) — never a second status
-- column that could disagree.
--
-- Concurrency rule (unique partial index): one decision per
-- (case, assessment), so two operators deciding on the same assessment at
-- once get a 409 conflict instead of silently doubling. Corrections and
-- reconsiderations cite a NEW assessment (new record, never an overwrite).
-- Withdrawals cite no assessment (they remove from pursuit, they do not
-- judge an assessment) and are therefore exempt from the uniqueness rule.
create table p2.case_decision (
  decision_id uuid primary key default gen_random_uuid(),
  case_id uuid not null references p2.case (case_id) on delete cascade,
  assessment_id uuid references p2.case_assessment (assessment_id),
  decision text not null check (decision in ('accepted', 'rejected', 'deferred', 'withdrawn')),
  reason text not null check (char_length(reason) between 1 and 2000),
  reason_code text check (reason_code is null or char_length(reason_code) between 1 and 80),
  resume_at timestamptz,
  resume_condition text check (resume_condition is null or char_length(resume_condition) between 1 and 2000),
  actor text not null check (char_length(actor) between 1 and 200),
  decided_at timestamptz not null default now(),
  -- A deferral without any resume condition is postponement without end:
  -- refused at the schema level, not just in code.
  check (decision <> 'deferred' or resume_at is not null or resume_condition is not null)
);
-- Accepted/rejected/deferred REQUIRE an assessment_id (enforced in lib with a
-- 422 — the verdict must cite what was reviewed); withdrawn MAY cite one or
-- none. One decision per (case, assessment): concurrent same-assessment
-- decisions conflict instead of doubling. Reconsideration cites a NEW
-- assessment, never reuses one.
create unique index p2_case_decision_one_per_assessment
  on p2.case_decision (case_id, assessment_id) where assessment_id is not null;
create index p2_case_decision_case_idx on p2.case_decision (case_id, decided_at desc);

-- Due flags for research tasks: an explicit operator-set deadline. NOTHING
-- reads this on a timer (no scheduler exists and none may): expiry is
-- derived at read time (open/accepted + due_at passed = overdue/expired
-- display). DoneFound vs DoneNoneFound are likewise DERIVED at read time
-- (done + submitted evidence vs done + negative finding), not new statuses —
-- the frozen four (open/accepted/done/dismissed) are unchanged.
alter table p2.research_task
  add column due_at timestamptz;

alter table p2.case_decision enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'p2_app') then
    grant insert on p2.case_decision to p2_app;
    grant select on p2.case_decision to p2_app;
    grant update (due_at, operator_notes) on p2.research_task to p2_app;
    -- No UPDATE/DELETE on decisions (immutable), no DELETE anywhere.
  end if;
end;
$$;

create policy p2_decision_p2app on p2.case_decision for all to p2_app using (true) with check (true);