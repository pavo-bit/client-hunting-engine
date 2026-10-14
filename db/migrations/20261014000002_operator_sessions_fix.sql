-- AUTH-001 fix: an expired session is a legitimate stored state.
-- The `expires_at > created_at` check seemed sensible at creation time, but it
-- breaks the expiry path itself: once a session expires, even marking it
-- revoked (UPDATE) violates the check, so expired sessions could never be
-- retired. Storage must allow expires_at <= created_at; "is this session
-- live?" stays an application-level predicate (expires_at > now() AND
-- revoked_at IS NULL), enforced in lib/auth/sessions.ts and covered by
-- tests/auth_session.test.ts. Additive fix; the creating migration is untouched.
do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'operator_session'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) = 'CHECK ((expires_at > created_at))';
  if cname is not null then
    execute format('alter table public.operator_session drop constraint %I', cname);
    raise notice 'dropped % (expired sessions are storable state)', cname;
  else
    raise notice 'expiry check already absent; nothing to do';
  end if;
end;
$$;
