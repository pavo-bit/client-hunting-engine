-- Phase 2: Greenhouse Job Board source registration.
--
-- Forward-only, additive. Nothing existing is modified or deleted.
--
-- Source registry row. S-07 is an ALREADY-APPROVED category ("Careers/hiring
-- platforms"), so this adds a vendor-specific connector inside it (same
-- precedent as gleif-api under S-02). The row is inserted DISABLED:
-- `source.enabled` is the sole runtime gate, and activation additionally
-- requires the recorded licensing/commercial-use decision that is still OPEN
-- (docs/P2_SOURCE_SELECTION.md §5). This migration does NOT enable any source
-- and does not grant that decision.
--
-- NOT INCLUDED: a new unique index on (source_key, source_record_id). One
-- already exists — discovery_record_source_uidx, a partial unique index on
-- those columns. It was initially missed because it is an INDEX, not a table
-- CONSTRAINT, and therefore absent from pg_constraint. The pre-existing index
-- already makes the documented record idempotency a database constraint, and
-- a second one would be redundant infrastructure.
insert into public.source (key, category, platform, reliability_prior, enabled, kind)
values (
  'greenhouse-job-board',
  'S-07',
  'Greenhouse Job Board API (boards-api.greenhouse.io)',
  'B',
  false,
  'connector'
)
on conflict (key) do nothing;