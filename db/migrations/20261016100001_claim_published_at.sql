-- Phase 1 signal foundation: source publication date on claims (additive).
--
-- Forward-only. Adds one nullable column; no existing row is touched and no
-- backfill is invented (publication dates for old rows are unknown, and
-- inventing them would fabricate provenance). Reversible by dropping the
-- column; nothing depends on it.
--
-- WHY: an evidence signal needs the SOURCE's publication/event date as a
-- fact distinct from three other timestamps the schema already keeps:
-- observed_at (when the world event happened / was seen), fetched_at (when
-- we captured it) and created_at (when the row was written). Before this
-- column, publication timing had nowhere to live except overloaded
-- observed_at, which conflates "event happened" with "source published".
-- All four stay nullable: when the source gives no date, we record nothing
-- rather than a default.
alter table public.claim
  add column published_at timestamptz;
