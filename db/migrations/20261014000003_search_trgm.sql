-- MILESTONE 2 (S-1): trigram search support (additive).
-- pg_trgm ships with the postgres:17 image; no new infrastructure. GIN trigram
-- indexes back the global operator search over companies, claims, hypotheses,
-- proposals, and briefs. Ranking itself is deterministic SQL in
-- lib/search/global.ts (exact > prefix > substring > similarity); the indexes
-- only bound the scan. IF NOT EXISTS throughout: safe to replay.

create extension if not exists pg_trgm;

create index if not exists company_search_name_trgm_idx
  on public.company using gin (name gin_trgm_ops);
create index if not exists company_search_domain_trgm_idx
  on public.company using gin (domain_norm gin_trgm_ops);
create index if not exists claim_search_text_trgm_idx
  on public.claim using gin (claim_text gin_trgm_ops);
create index if not exists hypothesis_search_title_trgm_idx
  on public.hypothesis using gin (title gin_trgm_ops);
create index if not exists proposal_search_title_trgm_idx
  on public.project_option using gin (title gin_trgm_ops);
create index if not exists brief_search_markdown_trgm_idx
  on public.brief using gin (markdown gin_trgm_ops);
