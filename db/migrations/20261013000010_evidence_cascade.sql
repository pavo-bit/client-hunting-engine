-- T-007 migration 8g: evidence-link cascade coherence.
-- claim_evidence.snapshot_id was ON DELETE RESTRICT, which deadlocked
-- company deletion: the cascade company -> claim -> claim_evidence and
-- company -> snapshot raced, with the snapshot branch blocked by surviving
-- link rows. Since claims, assessments, and snapshots all cascade from an
-- explicitly removed company anyway, link rows cascade too. UPDATE
-- protection is untouched (no trigger exists; links are immutable by
-- application discipline + tests). Audited company removal stays the
-- consequential, visible action.

alter table public.claim_evidence
  drop constraint if exists claim_evidence_snapshot_id_fkey;

alter table public.claim_evidence
  add constraint claim_evidence_snapshot_id_fkey
  foreign key (snapshot_id) references public.snapshot (id) on delete cascade;
