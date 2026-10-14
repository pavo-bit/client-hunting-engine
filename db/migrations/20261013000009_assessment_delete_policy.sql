-- T-007 migration 8f: assessment DELETE policy (same rationale as 8c).
-- UPDATEs stay forbidden (silent rewrites are the tampering vector);
-- DELETEs are permitted so explicit company removal (takedown, test
-- isolation) can cascade. Deletion is visible; the audited consequential
-- action is the company removal itself.

create or replace function public.t007_guard_assessment_append_only()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'DELETE' then
    return old; -- permitted: explicit removal (cascade or takedown)
  end if;
  raise exception 'claim_assessment is append-only (INSERT + SELECT only)';
end;
$$;
