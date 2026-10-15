-- Prompt 4 migration M1: discovery coverage tasks (blueprint §2).
-- Additive. Per-task accounting for planned refreshes; single-query runs
-- (lib/discovery/run.ts) are untouched and keep working with no tasks.
-- Stopping-rule evaluation lives in lib/discovery/coverage.ts; this table
-- only stores task state + yields. Forward-repair only (no down path).

create table public.discovery_coverage_task (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.discovery_run (id) on delete cascade,
  adapter_id text not null check (char_length(adapter_id) between 1 and 120),
  query_text text not null check (char_length(query_text) between 1 and 500),
  page_token text check (page_token is null or char_length(page_token) between 1 and 500),
  status text not null default 'pending' check (status in (
    'pending', 'running', 'done', 'exhausted', 'failed', 'skipped_low_yield'
  )),
  yield_new integer not null default 0 check (yield_new >= 0),
  yield_total integer not null default 0 check (yield_total >= 0),
  attempts integer not null default 0 check (attempts >= 0),
  -- Child single-query run executed for this task (nullable: tasks may
  -- finish without one on stop/failure paths). Lets refresh-level reads
  -- (duplicate items, per-task provenance) join without string parsing.
  child_run_id uuid references public.discovery_run (id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  note text,
  constraint coverage_task_finished_needs_timestamp check (
    (status in ('pending', 'running')) or finished_at is not null
  )
);
create index discovery_coverage_task_run_idx on public.discovery_coverage_task (run_id, status);
create index discovery_coverage_task_adapter_idx on public.discovery_coverage_task (adapter_id, started_at);

alter table public.discovery_coverage_task enable row level security;
revoke all on public.discovery_coverage_task from public;
