// Server-side agency-directory query (Phase 3).
//
// WHY THIS EXISTS: the directory previously fetched up to 500 rows and let the
// browser sort/filter them with TanStack Table. That is a presentation trick,
// not a filter: it cannot answer "how many match?", cannot paginate, and an
// export built on top of it would silently disagree with the screen. This
// module makes filtering/sorting/pagination a property of ONE SQL builder
// that the directory page and the export endpoint both call, so what the
// operator sees and what they download cannot drift apart.
//
// SAFETY: every identifier (sort column, direction, page size) is matched
// against a closed allowlist before it reaches SQL. Values are always bound as
// parameters. No caller-supplied string is ever concatenated into SQL.

import type { Pool } from "pg";

/** Closed sort allowlist. Anything else falls back to the default. */
export const AGENCY_SORT_COLUMNS = {
  name: "c.name",
  domain_norm: "c.domain_norm",
  agency_type: "c.agency_type",
  country: "c.country",
  discovery_status: "c.discovery_status",
  created_at: "c.created_at",
} as const;

export type AgencySortKey = keyof typeof AGENCY_SORT_COLUMNS;

/** Workflow states on public.company (NOT qualification verdicts). */
export const COMPANY_STATUSES = [
  "candidate",
  "resolved",
  "qualified",
  "rejected",
  "archived",
] as const;

export const PER_PAGE_OPTIONS = [25, 50, 100, 250] as const;
export const DEFAULT_PER_PAGE = 50;
/** Hard ceiling: an export must stay inside known system limits. */
export const MAX_PER_PAGE = 500;

export interface AgencyFilters {
  q: string;
  country: string | null;
  agencyType: string | null;
  status: string | null;
  /** Only canonical records (excludes merged/archived-away duplicates). */
  canonicalOnly: boolean;
  sort: AgencySortKey;
  dir: "asc" | "desc";
  page: number;
  perPage: number;
}

export interface AgencyDirectoryResult {
  rows: {
    id: string;
    name: string;
    domain_norm: string | null;
    registry_id: string | null;
    registry_type: string | null;
    agency_type: string;
    country: string;
    country_code: string | null;
    region: string | null;
    website_url: string | null;
    discovery_status: string;
    created_at: string;
    /** Distinct company names captured for this company (evidence volume). */
    evidence_count: number;
    /** Newest evidence observation date, or null when there is no evidence. */
    latest_evidence_at: string | null;
    /** Newest provenance source key, or null. */
    latest_source_key: string | null;
    merged_into: string | null;
  }[];
  total: number;
  page: number;
  perPage: number;
  pageCount: number;
  /** Distinct values available for the filter controls. */
  facets: { countries: string[]; agencyTypes: string[] };
}

function first(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s === "" ? null : s.slice(0, 200);
}

/** Parse and clamp untrusted query parameters. Never throws. */
export function parseAgencyFilters(params: URLSearchParams): AgencyFilters {
  const sortRaw = first(params.get("sort"));
  const sort: AgencySortKey =
    sortRaw !== null && sortRaw in AGENCY_SORT_COLUMNS
      ? (sortRaw as AgencySortKey)
      : "created_at";
  const dir = first(params.get("dir"))?.toLowerCase() === "asc" ? "asc" : "desc";
  const pageRaw = Number.parseInt(params.get("page") ?? "1", 10);
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const perRaw = Number.parseInt(params.get("perPage") ?? String(DEFAULT_PER_PAGE), 10);
  const perPage = PER_PAGE_OPTIONS.includes(perRaw as (typeof PER_PAGE_OPTIONS)[number])
    ? perRaw
    : Number.isInteger(perRaw) && perRaw > 0
      ? Math.min(perRaw, MAX_PER_PAGE)
      : DEFAULT_PER_PAGE;
  const status = first(params.get("status"));
  return {
    q: first(params.get("q")) ?? "",
    country: first(params.get("country")),
    agencyType: first(params.get("agencyType")),
    status:
      status !== null && (COMPANY_STATUSES as readonly string[]).includes(status)
        ? status
        : null,
    canonicalOnly: first(params.get("canonicalOnly")) !== "false",
    sort,
    dir,
    page,
    perPage,
  };
}

interface Built {
  where: string;
  params: unknown[];
}

function buildWhere(f: AgencyFilters): Built {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (f.q !== "") {
    params.push(`%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
    const i = `$${params.length}`;
    clauses.push(
      // id is searchable so an operator holding a UUID from elsewhere (an
      // export, a run item, an evidence page) can jump straight to the record.
      `(c.id::text ilike ${i} escape '\\' or c.name ilike ${i} escape '\\' or coalesce(c.domain_norm,'') ilike ${i} escape '\\' or c.country ilike ${i} escape '\\' or coalesce(c.registry_id,'') ilike ${i} escape '\\')`,
    );
  }
  if (f.country !== null) {
    params.push(f.country);
    clauses.push(`c.country = $${params.length}`);
  }
  if (f.agencyType !== null) {
    params.push(f.agencyType);
    clauses.push(`c.agency_type = $${params.length}`);
  }
  if (f.status !== null) {
    params.push(f.status);
    clauses.push(`c.discovery_status = $${params.length}`);
  }
  if (f.canonicalOnly) clauses.push("c.merged_into is null");
  return { where: clauses.length > 0 ? `where ${clauses.join(" and ")}` : "", params };
}

const SELECT_COLUMNS = `
  c.id, c.name, c.domain_norm, c.registry_id, c.registry_type, c.agency_type,
  c.country, c.country_code, c.region, c.website_url, c.discovery_status,
  c.created_at, c.merged_into,
  coalesce(ev.n, 0)::int as evidence_count,
  ev.latest as latest_evidence_at,
  ev.source_key as latest_source_key`;

/**
 * Evidence roll-up per company. Counts DISTINCT snapshots (the observation
 * units), and reports the newest observation date and its source. `latest` is
 * computed by timestamp, not by id, so an older-but-later-dated record wins.
 */
const EVIDENCE_JOIN = `
  left join lateral (
    select count(distinct s.id)::int as n,
           max(s.fetched_at) as latest,
           (array_agg(s.source_key order by s.fetched_at desc nulls last))[1] as source_key
      from public.snapshot s
     where s.company_id = c.id
  ) ev on true`;

/** Shared by the directory page and the export endpoint. */
export async function fetchAgencyDirectory(
  pool: Pool,
  f: AgencyFilters,
): Promise<AgencyDirectoryResult> {
  const { where, params } = buildWhere(f);
  const sortCol = AGENCY_SORT_COLUMNS[f.sort];
  const dir = f.dir === "asc" ? "asc" : "desc";

  const totalRes = await pool.query(
    `select count(*)::int as n from public.company c ${where}`,
    params,
  );
  const total = totalRes.rows[0].n as number;
  const pageCount = Math.max(1, Math.ceil(total / f.perPage));
  // Clamp rather than trust: an out-of-range page yields the last page, never
  // an empty result that looks like "no matches".
  const page = Math.min(Math.max(f.page, 1), pageCount);

  const rowsRes = await pool.query(
    `select ${SELECT_COLUMNS}
       from public.company c ${EVIDENCE_JOIN} ${where}
      order by ${sortCol} ${dir} nulls last, c.id asc
      limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, f.perPage, (page - 1) * f.perPage],
  );

  const facetsRes = await pool.query(
    `select
       (select array_agg(x.country order by x.country)
          from (select distinct country from public.company where merged_into is null) x
        where x.country is not null and x.country <> '') as countries,
       (select array_agg(y.agency_type order by y.agency_type)
          from (select distinct agency_type from public.company where merged_into is null) y
        where y.agency_type is not null and y.agency_type <> '') as agency_types`,
  );

  return {
    rows: rowsRes.rows as AgencyDirectoryResult["rows"],
    total,
    page,
    perPage: f.perPage,
    pageCount,
    facets: {
      countries: (facetsRes.rows[0]?.countries ?? []) as string[],
      agencyTypes: (facetsRes.rows[0]?.agency_types ?? []) as string[],
    },
  };
}

/**
 * All rows matching the SAME filter, for export. Hard-capped so an export can
 * never become an unbounded query; the cap is reported, never silent.
 */
export async function fetchAgencyRowsForExport(
  pool: Pool,
  f: AgencyFilters,
  hardCap = MAX_PER_PAGE,
): Promise<{ rows: AgencyDirectoryResult["rows"]; capped: boolean }> {
  const { where, params } = buildWhere(f);
  const sortCol = AGENCY_SORT_COLUMNS[f.sort];
  const dir = f.dir === "asc" ? "asc" : "desc";
  const res = await pool.query(
    `select ${SELECT_COLUMNS}
       from public.company c ${EVIDENCE_JOIN} ${where}
      order by ${sortCol} ${dir} nulls last, c.id asc
      limit $${params.length + 1}`,
    [...params, hardCap + 1],
  );
  const rows = res.rows as AgencyDirectoryResult["rows"];
  return { rows: rows.slice(0, hardCap), capped: rows.length > hardCap };
}