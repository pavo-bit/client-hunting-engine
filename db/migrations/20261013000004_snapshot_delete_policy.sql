-- T-004 migration 8c: snapshot DELETE policy correction (additive).
--
-- CORRECTION (recorded D-011): the T-002 snapshot guard blocked DELETE as
-- well as UPDATE. That made company cleanup (tests, takedown deletes via
-- cascade) impossible: any company owning a snapshot could never be removed.
-- New policy: UPDATEs remain forbidden except takedown suppression;
-- DELETEs are permitted (they flow from an explicit company delete, which is
-- the audited consequential action; no delete endpoint exists yet).
-- Evidence tampering via UPDATE stays blocked and tested.

create or replace function public.t002_guard_snapshot_mutation()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'DELETE' then
    return old; -- permitted: explicit removal (cascade or takedown)
  end if;
  if new.suppressed is distinct from old.suppressed then
    if old.suppressed = false and new.suppressed = true
       and new.id = old.id
       and new.company_id = old.company_id
       and new.source_key = old.source_key
       and new.research_run_id is not distinct from old.research_run_id
       and new.url = old.url
       and new.fetched_at = old.fetched_at
       and new.sha256 = old.sha256
       and new.store_ref is not distinct from old.store_ref
       and new.content_excerpt is not distinct from old.content_excerpt
       and new.retention_class = old.retention_class
       and new.created_at = old.created_at then
      return new; -- takedown suppression permitted
    end if;
  end if;
  raise exception 'snapshot rows are immutable except takedown suppression';
end;
$$;
