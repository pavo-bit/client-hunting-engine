-- T-010 migration 8k: outcome cascade coherence.
-- outcome_log.brief_ref was ON DELETE RESTRICT, blocking explicit company
-- removal whenever outcomes were recorded. Outcomes belong to the brief's
-- history: they cascade with it. Recording stays append-only in practice
-- (no update/delete API exists); deletion flows only from audited company
-- removal, consistent with claim_evidence (8g).

alter table public.outcome_log
  drop constraint if exists outcome_log_brief_ref_fkey;

alter table public.outcome_log
  add constraint outcome_log_brief_ref_fkey
  foreign key (brief_ref) references public.brief (ref) on delete cascade;
