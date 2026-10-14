-- T-004 migration 8d: registry type, alias verification, candidate reopening.
-- Additive; prior migrations untouched.
--
-- 1. company.registry_type (nullable free text, e.g. 'companies-house',
--    'handelsregister', 'ein', 'duns'): registry matches additionally require
--    type agreement when BOTH sides state a type (veto on conflict). NULL
--    means unknown — matching falls back to jurisdiction-scoped id equality,
--    and registry matches always go to human review, never auto-merge.
-- 2. company_alias.verification ('verified' | 'unverified', default
--    'verified'): merge-created aliases are human-reviewed or deterministic
--    outcomes, hence verified. Only verified aliases feed the alias rule;
--    unverified aliases are informational (future assertion paths, TBD).
--    company_alias.country_code: jurisdiction for registry-type aliases.
-- 3. match_candidate.reopen_reason / reopened_at: rejected/deferred rows stay
--    decided; only an explicit reopen with new material evidence returns a
--    candidate to pending, preserving the prior decision in the audit trail.

alter table public.company
  add column registry_type text check (
    registry_type is null or char_length(registry_type) between 1 and 60
  );

alter table public.company_alias
  add column verification text not null default 'verified' check (
    verification in ('verified', 'unverified')
  );

alter table public.company_alias
  add column country_code char(2) check (
    country_code is null or country_code = upper(country_code)
  );

alter table public.company_alias
  add column note text;

alter table public.match_candidate
  add column reopen_reason text;

alter table public.match_candidate
  add column reopened_at timestamptz;

create index match_candidate_reopen_idx on public.match_candidate (status)
  where status = 'pending';
