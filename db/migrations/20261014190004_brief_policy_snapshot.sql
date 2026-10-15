-- Prompt 4 migration M4: brief policy-version snapshot (additive, nullable).
-- Records which D-* policy + scoring/rule versions produced a brief, so a
-- brief stays reproducible against the rules of its time (amendment §4D).
-- Nullable: pre-snapshot briefs read as policy_version IS NULL ("pre-snapshot
-- era") — never backfilled with invented values. No default: callers state
-- the version explicitly or leave it null. Forward-repair only.

alter table public.brief
  add column policy_version text check (
    policy_version is null or char_length(policy_version) between 1 and 120
  );
