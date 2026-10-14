-- T-011 migration: versioned scoring runs with provenance detail.
-- Additive. Existing hand-written rows are marked model_version 'legacy'
-- (no provenance behind them; never presented as engine output).
-- Engine rows (score_v1) record: model version, per-dimension rationale with
-- input references, missing-dimension flags, evaluation timestamp.
-- History is append-only in practice: evaluations INSERT new rows; no
-- update/delete API exists. Totals/bands keep legacy component columns for
-- continuity (weights provisional, D-006 open).

alter table public.score_run
  add column model_version text not null default 'score_v1' check (
    char_length(model_version) between 1 and 30
  );

alter table public.score_run
  add column detail jsonb not null default '{}' check (
    octet_length(detail::text) <= 12000
  );

alter table public.score_run
  add column evaluated_at timestamptz not null default now();

alter table public.score_run
  add column partial boolean not null default false;

-- No evaluation engine existed before this migration, so every pre-existing
-- row is legacy by definition (hand-written components, no provenance).
update public.score_run set model_version = 'legacy';

create index score_run_hypothesis_version_idx
  on public.score_run (hypothesis_id, evaluated_at desc);
