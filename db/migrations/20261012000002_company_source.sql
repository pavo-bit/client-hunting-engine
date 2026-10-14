-- T-002 migration 2/6: company identity, source registry, discovery records.
-- Worldwide agencies: country/region are attributes; no single-country gating.
-- Dedup: name alone is NOT unique; domain_norm / registry_id carry partial uniques.

-- Canonical company (one row per real business).
create table public.company (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 300),
  domain_norm text check (
    domain_norm is null
    or (
      domain_norm = lower(domain_norm)
      and domain_norm not like 'www.%'
      and domain_norm like '%.%'
    )
  ),
  registry_id text,
  agency_type text not null check (agency_type in (
    'web_development', 'custom_software', 'mobile_app',
    'ecommerce', 'automation_consultancy', 'other_digital'
  )),
  country text not null check (char_length(country) between 1 and 120),
  country_code char(2) check (country_code = upper(country_code)),
  region text check (region is null or char_length(region) between 1 and 120),
  website_url text check (
    website_url is null
    or website_url like 'http://%' or website_url like 'https://%'
  ),
  discovery_status text not null default 'candidate' check (discovery_status in (
    'candidate', 'resolved', 'qualified', 'rejected', 'archived'
  )),
  rejected_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_rejection_needs_reason check (
    (discovery_status = 'rejected' and rejected_reason is not null)
    or discovery_status <> 'rejected'
  )
);

-- Partial uniques: verified identifiers collide, unverified NULLs do not.
create unique index company_domain_norm_uidx on public.company (domain_norm)
  where domain_norm is not null;
create unique index company_registry_id_uidx on public.company (registry_id)
  where registry_id is not null;
create index company_name_idx on public.company (name);
create index company_agency_country_idx on public.company (agency_type, country_code);

-- Merge history: losing identities preserved as aliases, never deleted silently.
create table public.company_alias (
  id uuid primary key default gen_random_uuid(),
  canonical_company_id uuid not null references public.company (id) on delete cascade,
  alias_type text not null check (alias_type in ('domain', 'registry_id', 'handle')),
  alias_value text not null check (char_length(alias_value) between 1 and 300),
  created_at timestamptz not null default now(),
  constraint company_alias_value_uidx unique (alias_type, alias_value)
);
create index company_alias_canonical_idx on public.company_alias (canonical_company_id);

-- Source registry: exactly the 12 approved categories (S-01..S-12).
-- Reddit/YouTube cannot be represented: no category value exists for them.
create table public.source (
  key text primary key check (char_length(key) between 1 and 120),
  category text not null check (category in (
    'S-01', 'S-02', 'S-03', 'S-04', 'S-05', 'S-06',
    'S-07', 'S-08', 'S-09', 'S-10', 'S-11', 'S-12'
  )),
  platform text not null check (char_length(platform) between 1 and 200),
  reliability_prior char(1) not null check (reliability_prior in ('A', 'B', 'C', 'D')),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

-- Discovery intake: source_key NULL = direct operator entry (provenance 'manual').
create table public.discovery_record (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id) on delete cascade,
  source_key text references public.source (key) on delete restrict,
  source_url text,
  collection_method text not null check (collection_method in (
    'manual', 'api', 'import', 'observed_page'
  )),
  retrieved_at timestamptz not null default now(),
  retrieval_status text not null default 'ok' check (retrieval_status in (
    'ok', 'rate_limited', 'auth_blocked', 'terms_blocked',
    'parse_error', 'network_error', 'injection_suspect'
  )),
  query_text text,
  adapter_version text,
  note text,
  created_at timestamptz not null default now()
);
create index discovery_record_company_idx on public.discovery_record (company_id);
create index discovery_record_source_idx on public.discovery_record (source_key);

-- The 12 approved source categories as reference rows (disabled until D-003 prioritizes).
insert into public.source (key, category, platform, reliability_prior, enabled) values
  ('search-web',        'S-01', 'search engine (per-query provider)', 'C', false),
  ('registry-generic',  'S-02', 'official company registry (per jurisdiction)', 'A', false),
  ('biz-directory',     'S-03', 'startup/business directory', 'C', false),
  ('launch-platform',   'S-04', 'product-launch platform', 'C', false),
  ('agency-directory',  'S-05', 'agency/service-provider directory', 'B', true),
  ('dev-ecosystem',     'S-06', 'developer/open-source ecosystem', 'B', false),
  ('hiring-platform',   'S-07', 'careers/hiring platform', 'C', false),
  ('company-site',      'S-08', 'company-owned website/announcements', 'B', true),
  ('linkedin',          'S-09', 'LinkedIn (permitted means only)', 'C', false),
  ('x-platform',        'S-10', 'X (official API tiers only)', 'D', false),
  ('instagram',         'S-11', 'Instagram (official API only)', 'D', false),
  ('facebook',          'S-12', 'Facebook (official API only)', 'D', false)
on conflict (key) do nothing;

create trigger company_set_updated_at
  before update on public.company
  for each row execute function public.t002_set_updated_at();
