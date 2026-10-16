-- Phase 4 / B4: human review labels for source records.
--
-- WHY THIS IS NECESSARY: pilot "precision" cannot be derived from qualification
-- decisions. `p2.case_decision.decision = 'accepted'` records that an operator
-- chose to pursue an opportunity; it says nothing about whether the SOURCE
-- RECORD underneath was factually correct. Nothing in the schema could express
-- "a human checked this observation and marked it correct/incorrect", so any
-- precision figure would have been fabricated from an unrelated signal.
--
-- This is the minimum addition that closes that gap:
--   * it stores LABELS only — no score, no policy verdict, no ranking input;
--   * it is never read by the qualification engine, the gate registry, the
--     scoring model or the discovery run path, so it cannot influence a
--     decision (scoring decisions and review labels stay separate concepts);
--   * it is append-only from the application's point of view: rows are never
--     updated by any code path, and re-reviewing inserts a new row.
--
-- Forward-only and additive. Reversible by dropping the table.
create table if not exists public.source_record_review (
  id uuid primary key default gen_random_uuid(),
  -- Which source produced the record. FK keeps labels attached to a real,
  -- registered source; an unknown key is refused rather than stored loosely.
  source_key text not null references public.source (key) on delete restrict,
  -- Stable provider identity of the reviewed record, exactly as stored in
  -- discovery_record.source_record_id (tenant-scoped, e.g. `board:jobId`).
  source_record_id text not null check (char_length(source_record_id) between 1 and 300),
  -- The run that produced it, when known. ON DELETE SET NULL: a review label
  -- must survive the deletion of the run it refers to, because the label is
  -- evidence about a source record, not about the run.
  run_id uuid null references public.discovery_run (id) on delete set null,
  reviewer text not null check (char_length(reviewer) between 1 and 200),
  reviewed_at timestamptz not null default now(),
  -- Human correctness label. 'unusable' is recorded separately so it can be
  -- counted and excluded from the precision denominator without being hidden.
  label text not null check (label in ('correct', 'incorrect', 'unusable')),
  note text null check (note is null or char_length(note) <= 2000),
  -- Two identical judgements by the same reviewer at the same instant are a
  -- double-submit, not two independent reviews.
  unique (source_key, source_record_id, reviewer, reviewed_at)
);

comment on table public.source_record_review is
  'Human review labels for source records. Reporting input only; never a ranking or gating input.';

create index if not exists source_record_review_source_idx
  on public.source_record_review (source_key, reviewed_at);
create index if not exists source_record_review_record_idx
  on public.source_record_review (source_key, source_record_id);