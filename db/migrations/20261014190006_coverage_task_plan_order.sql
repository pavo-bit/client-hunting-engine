-- Prompt 5 migration M6: coverage-task plan order + creation time.
-- Additive, forward-repair only. Fixes a real defect found by executing the
-- Prompt 4 coverage tests: claimTask ordered by `created_at`, which this table
-- never had, so every planned refresh failed on the first claim.
--
-- Two columns, two jobs:
--   plan_seq    - position in the operator's plan. Claiming must follow plan
--                 order deterministically; a timestamp alone cannot (all rows
--                 of one plan are inserted in the same transaction/microsecond
--                 window) and `id` is a random uuid, so neither is FIFO.
--   created_at  - real creation time for history/triage.
--
-- Existing rows (Prompt 4 test traffic only): plan_seq defaults to 0 and
-- created_at to the migration timestamp - ties break by id. No backfill
-- invents an order that was never recorded.

alter table public.discovery_coverage_task
  add column plan_seq integer not null default 0 check (plan_seq >= 0),
  add column created_at timestamptz not null default now();

-- Claim path: FIFO within a run.
create index discovery_coverage_task_plan_idx
  on public.discovery_coverage_task (run_id, plan_seq, created_at, id);