-- T-008 migration 8j: hypothesis default follows the new lifecycle.
-- Migration 8h replaced the status vocabulary but left the old 'proposed'
-- default, rejecting inserts that omit status. New rows default to
-- 'generated' (unevaluated by a human).

alter table public.hypothesis
  alter column status set default 'generated';
