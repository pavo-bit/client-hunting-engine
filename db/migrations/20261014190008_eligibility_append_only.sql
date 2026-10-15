-- Prompt 5 migration M8: eligibility history is append-only (finding F3).
--
-- Forward-only. No existing row is touched, no column changes, nothing is
-- backfilled.
--
-- Why: `opportunity_eligibility` is the record of WHO decided an opportunity
-- eligible/ineligible and under WHICH policy version. Without a database-level
-- guard, any UPDATE silently rewrites that history - and an application-level
-- convention ("we only ever insert") is exactly the kind of assumption that
-- rots. `audit_log` already proves the pattern in this schema
-- (t002_guard_audit_append_only); claim_assessment (t007) proves the variant
-- used where a parent row must still be deletable.
--
-- Which variant, and why not the stricter one: `audit_log` forbids UPDATE and
-- DELETE outright because it is the system of record for decisions. Eligibility
-- history is a per-opportunity ledger and its rows are `on delete cascade` from
-- `opportunity`. Forbidding DELETE would break:
--   - explicit opportunity removal (retention/takedown, T-007 8f rationale),
--   - test isolation (suites delete their own opportunities),
--   - company takedown cascades.
-- So UPDATE is forbidden (silent rewriting is the tampering vector) and DELETE
-- stays permitted only as the consequence of removing the parent row - the same
-- trade-off already recorded for claim_assessment.
--
-- Trigger fires for EVERY role including the table owner (superuser can only
-- bypass it by disabling triggers session-wide, which is out of scope for the
-- app, which never connects as superuser). `noaccess` additionally holds no
-- grants on this table, so RLS/REVOKE parity is unchanged from M3.

create or replace function public.t014_guard_eligibility_append_only()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'DELETE' then
    return old; -- permitted: cascade from opportunity removal (see header)
  end if;
  raise exception 'opportunity_eligibility is append-only (INSERT + SELECT only; UPDATE is forbidden)';
end;
$$;

create trigger opportunity_eligibility_append_only
  before update or delete on public.opportunity_eligibility
  for each row execute function public.t014_guard_eligibility_append_only();