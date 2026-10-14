-- T-003 migration 7/7: CSV import staging (preview -> explicit confirm -> commit).
-- Atomicity: PARTIAL SUCCESS per FR-002 (atomic-per-row). Staged rows carry
-- their own status; confirm commits valid rows in one transaction with
-- per-row savepoints (app-side). Nothing here sends, delivers, or contacts.

create table public.import_batch (
  id uuid primary key default gen_random_uuid(),
  filename text not null check (char_length(filename) between 1 and 300),
  file_sha256 char(64) not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  total_rows integer not null check (total_rows >= 0),
  status text not null default 'draft' check (status in (
    'draft', 'committed', 'discarded'
  )),
  created_by text not null check (char_length(created_by) between 1 and 200),
  created_at timestamptz not null default now(),
  committed_at timestamptz
);

create table public.import_row (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.import_batch (id) on delete cascade,
  row_number integer not null check (row_number >= 2),
  raw jsonb not null check (octet_length(raw::text) <= 20000),
  status text not null default 'pending' check (status in (
    'pending', 'valid', 'invalid', 'duplicate_in_file',
    'conflict_existing', 'skipped', 'imported'
  )),
  error text,
  formula_risk boolean not null default false,
  company_id uuid references public.company (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint import_row_number_uidx unique (batch_id, row_number)
);
create index import_row_batch_idx on public.import_row (batch_id, status);

-- Same RLS baseline as T-002: enabled, no permissive policies, explicit deny.
alter table public.import_batch enable row level security;
alter table public.import_row enable row level security;
revoke all on public.import_batch from public;
revoke all on public.import_row from public;
