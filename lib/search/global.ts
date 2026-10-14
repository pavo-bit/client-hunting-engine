// MILESTONE 2 (S-1): global operator search (read-only projection).
//
// One bounded query per domain over companies, claims, hypotheses, proposals,
// and briefs. Ranking is deterministic, explainable SQL — exact match first,
// then prefix, then substring, then trigram similarity — with created/id
// tie-breaks. No stored rank, no ML, no query logging. All inputs validated;
// all SQL parameterized. Results link to the owning workflow; the search
// never mutates anything (it performs no writes at all).

import type { Pool } from "pg";

export interface SearchHit {
  id: string;
  title: string;
  snippet: string;
  companyId: string | null;
  companyName: string | null;
  status: string;
  href: string;
}

export interface SearchGroup {
  /** Total matches (uncapped); rows.length <= perDomain. */
  total: number;
  rows: SearchHit[];
}

export interface GlobalSearchResult {
  query: string;
  perDomain: number;
  companies: SearchGroup;
  claims: SearchGroup;
  hypotheses: SearchGroup;
  proposals: SearchGroup;
  briefs: SearchGroup;
}

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 200;
export const SEARCH_DEFAULT_PER_DOMAIN = 10;
export const SEARCH_MAX_PER_DOMAIN = 25;

function fail(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

function rankFragment(field: string): string {
  // 0 exact, 1 prefix, 2 substring, 3 similarity-only. Lower is better.
  return `case when lower(${field}) = lower($1) then 0
          when lower(${field}) like lower($1) || '%' then 1
          when ${field} ilike '%' || $1 || '%' then 2
          else 3 end`;
}

/**
 * Company-name-aware rank: the LEAST (best) of the title rank and the
 * owning-company name rank. Searching "Acme" therefore finds Acme's
 * hypotheses, proposals, briefs, and claims — not just its directory row.
 */
function rankWithCompany(titleField: string): string {
  return `least(${rankFragment(titleField)}, ${rankFragment("c.name")})`;
}

function matchFragment(field: string): string {
  return `($1 <> '' and (${field} ilike '%' || $1 || '%' or similarity(${field}, $1) > 0.18))`;
}

/** Match predicate extended with the owning-company name. */
function matchWithCompany(field: string): string {
  return `($1 <> '' and (${field} ilike '%' || $1 || '%' or similarity(${field}, $1) > 0.18 or c.name ilike '%' || $1 || '%' or similarity(c.name, $1) > 0.18))`;
}

type RowSpec = {
  key: keyof Omit<GlobalSearchResult, "query" | "perDomain">;
  sql: (rank: string, match: string) => string;
  countSql: (match: string) => string;
  toHit: (row: Record<string, unknown>) => SearchHit;
};

const SPECS: RowSpec[] = [
  {
    key: "companies",
    sql: (rank, match) => `
      select c.id, c.name as title, coalesce(c.domain_norm, '') as snippet,
             c.id as company_id, c.name as company_name, c.discovery_status as status,
             ${rank.replaceAll("FIELD", "c.name")} as rankclass,
             greatest(similarity(c.name, $1), similarity(coalesce(c.domain_norm, ''), $1)) as sim,
             c.created_at
      from public.company c
      where c.merged_into is null and (${match.replaceAll("FIELD", "c.name")} or ${match.replaceAll("FIELD", "coalesce(c.domain_norm, '')")})
      order by rankclass asc, sim desc, c.created_at desc, c.id asc
      limit $2`,
    countSql: (match) => `
      select count(*)::int as n from public.company c
      where c.merged_into is null and (${match.replaceAll("FIELD", "c.name")} or ${match.replaceAll("FIELD", "coalesce(c.domain_norm, '')")})`,
    toHit: (r) => ({
      id: r.id as string,
      title: r.title as string,
      snippet: r.snippet as string,
      companyId: r.company_id as string,
      companyName: r.company_name as string,
      status: r.status as string,
      href: `/agencies/${r.id as string}`,
    }),
  },
  {
    key: "claims",
    sql: () => `
      select cl.id, left(cl.claim_text, 120) as title, left(cl.claim_text, 200) as snippet,
             c.id as company_id, c.name as company_name, cl.claim_status as status,
             ${rankWithCompany("cl.claim_text")} as rankclass,
             similarity(cl.claim_text, $1) as sim, cl.created_at
      from public.claim cl join public.company c on c.id = cl.company_id
      where ${matchWithCompany("cl.claim_text")}
      order by rankclass asc, sim desc, cl.created_at desc, cl.id asc
      limit $2`,
    countSql: () => `
      select count(*)::int as n from public.claim cl join public.company c on c.id = cl.company_id
      where ${matchWithCompany("cl.claim_text")}`,
    toHit: (r) => ({
      id: r.id as string,
      title: r.title as string,
      snippet: r.snippet as string,
      companyId: r.company_id as string,
      companyName: r.company_name as string,
      status: r.status as string,
      href: `/evidence/${r.id as string}`,
    }),
  },
  {
    key: "hypotheses",
    sql: () => `
      select h.id, h.title, left(coalesce(h.rationale, ''), 200) as snippet,
             c.id as company_id, c.name as company_name, h.status,
             ${rankWithCompany("h.title")} as rankclass,
             similarity(h.title, $1) as sim, h.created_at
      from public.hypothesis h join public.company c on c.id = h.company_id
      where ${matchWithCompany("h.title")}
      order by rankclass asc, sim desc, h.created_at desc, h.id asc
      limit $2`,
    countSql: () => `
      select count(*)::int as n from public.hypothesis h join public.company c on c.id = h.company_id
      where ${matchWithCompany("h.title")}`,
    toHit: (r) => ({
      id: r.id as string,
      title: r.title as string,
      snippet: r.snippet as string,
      companyId: r.company_id as string,
      companyName: r.company_name as string,
      status: r.status as string,
      href: `/hypotheses/${r.id as string}`,
    }),
  },
  {
    key: "proposals",
    sql: () => `
      select p.id, p.title, left(coalesce(p.scope_in, ''), 200) as snippet,
             c.id as company_id, c.name as company_name, p.status,
             ${rankWithCompany("p.title")} as rankclass,
             similarity(p.title, $1) as sim, p.created_at
      from public.project_option p
      join public.hypothesis h on h.id = p.hypothesis_id
      join public.company c on c.id = h.company_id
      where ${matchWithCompany("p.title")}
      order by rankclass asc, sim desc, p.created_at desc, p.id asc
      limit $2`,
    countSql: () => `
      select count(*)::int as n from public.project_option p
      join public.hypothesis h on h.id = p.hypothesis_id
      join public.company c on c.id = h.company_id
      where ${matchWithCompany("p.title")}`,
    toHit: (r) => ({
      id: r.id as string,
      title: r.title as string,
      snippet: r.snippet as string,
      companyId: r.company_id as string,
      companyName: r.company_name as string,
      status: r.status as string,
      href: `/proposals/${r.id as string}`,
    }),
  },
  {
    key: "briefs",
    sql: () => `
      select b.ref as id, ('Brief ' || b.ref || ' (' || b.status || ')') as title,
             left(b.markdown, 200) as snippet,
             c.id as company_id, c.name as company_name, b.status,
             ${rankWithCompany("b.markdown")} as rankclass,
             similarity(b.markdown, $1) as sim, b.created_at
      from public.brief b join public.company c on c.id = b.company_id
      where ${matchWithCompany("b.markdown")}
      order by rankclass asc, sim desc, b.created_at desc, b.ref asc
      limit $2`,
    countSql: () => `
      select count(*)::int as n from public.brief b join public.company c on c.id = b.company_id
      where ${matchWithCompany("b.markdown")}`,
    toHit: (r) => ({
      id: r.id as string,
      title: r.title as string,
      snippet: r.snippet as string,
      companyId: r.company_id as string,
      companyName: r.company_name as string,
      status: r.status as string,
      href: `/briefs/${r.id as string}`,
    }),
  },
];

export async function globalSearch(
  pool: Pool,
  query: string,
  perDomain = SEARCH_DEFAULT_PER_DOMAIN,
): Promise<GlobalSearchResult> {
  const q = (query ?? "").trim().slice(0, SEARCH_MAX);
  if (q.length < SEARCH_MIN)
    throw fail(422, "bad_query", `search needs at least ${SEARCH_MIN} characters`);
  const per = Math.min(Math.max(Number.isFinite(perDomain) ? Math.trunc(perDomain) : SEARCH_DEFAULT_PER_DOMAIN, 1), SEARCH_MAX_PER_DOMAIN);

  const out = {
    query: q,
    perDomain: per,
    companies: { total: 0, rows: [] },
    claims: { total: 0, rows: [] },
    hypotheses: { total: 0, rows: [] },
    proposals: { total: 0, rows: [] },
    briefs: { total: 0, rows: [] },
  } as GlobalSearchResult;

  for (const spec of SPECS) {
    const rank = rankFragment("FIELD");
    const match = matchFragment("FIELD");
    const rows = await pool.query(spec.sql(rank, match), [q, per]);
    const count = await pool.query(spec.countSql(match), [q]);
    (out[spec.key] as SearchGroup) = {
      total: count.rows[0].n as number,
      rows: rows.rows.map((r) => spec.toHit(r as Record<string, unknown>)),
    };
  }
  return out;
}
