-- T-008 migration 8i: polarity-aware evidence links.
-- A single observation can both trigger a rule (supporting context) and
-- argue against its conclusion (contradiction). The old PK on
-- (hypothesis_id, claim_id) silently collapsed the second polarity via
-- ON CONFLICT DO NOTHING. The key becomes (hypothesis_id, claim_id,
-- polarity) so both relationships persist and reviewers see each claim
-- under every applicable heading.

alter table public.hypothesis_evidence
  drop constraint if exists hypothesis_evidence_pkey;

alter table public.hypothesis_evidence
  add constraint hypothesis_evidence_pkey
  primary key (hypothesis_id, claim_id, polarity);
