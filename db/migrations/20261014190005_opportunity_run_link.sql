-- Prompt 5 migration M5: link opportunities to their discovering run.
-- Additive, nullable. Lets refresh-level counters (new/promoted/evidence per
-- run) be computed from stored rows instead of inferred. Pre-existing
-- opportunities read run_id IS NULL ("pre-linkage era") — never backfilled
-- with invented run ids. Forward-repair only (no down path).

alter table public.opportunity
  add column run_id uuid references public.discovery_run (id) on delete set null;

create index opportunity_run_idx on public.opportunity (run_id);
