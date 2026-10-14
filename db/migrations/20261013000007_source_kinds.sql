-- T-006 migration: distinguish policy categories from live connectors.
-- The 12 approved categories (S-01..S-12) are LOCKED policy rows; live
-- connectors (e.g. gleif-api) are instance rows under a category. This keeps
-- the 12-category invariant exact while allowing audited live sources.

alter table public.source
  add column kind text not null default 'category' check (
    kind in ('category', 'connector')
  );

update public.source set kind = 'connector' where key = 'gleif-api';
