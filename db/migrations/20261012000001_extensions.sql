-- T-002 migration 1/6: extensions and shared helpers.
-- Proves: pgcrypto available for gen_random_uuid(); updated_at maintenance trigger.

create extension if not exists "pgcrypto";

-- Shared trigger: refresh updated_at on row modification.
create or replace function public.t002_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
