-- T-004 migration 8b: scope dedup uniques to canonical records + jurisdiction.
--
-- RATIONALE (recorded D-011): FR-003 forbids duplicate *canonical* records.
-- The T-002 partial uniques covered archived (merged-away) rows too, which
-- (a) blocked legitimate re-intake of a domain after a domain change, and
-- (b) treated registry IDs as globally unique although identical IDs under
-- different jurisdictions are unrelated registries.
-- New semantics: uniqueness enforced among canonical rows (merged_into IS
-- NULL) only; registry IDs scoped by (registry_id, country_code), with NULL
-- country codes never colliding (unknown jurisdiction = no dedup claim).
-- History rows keep their values; aliases preserve continuity.

drop index if exists public.company_domain_norm_uidx;
drop index if exists public.company_registry_id_uidx;

create unique index company_domain_norm_uidx on public.company (domain_norm)
  where domain_norm is not null and merged_into is null;

create unique index company_registry_id_uidx
  on public.company (registry_id, country_code)
  where registry_id is not null and merged_into is null;
