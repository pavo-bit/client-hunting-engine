// Reads of the frozen qualification view (Part 1, migration M9).
//
// This module is the ONLY sanctioned way for Phase 2 code to observe
// Discovery. It selects explicit columns from
// `public.v_opportunity_for_qualification_v1` — never `select *`, so a future
// v2 column can never leak in silently — and refuses anything but the v1 view
// name, so a renamed contract fails loudly instead of reading a changed meaning.

import type { Pool } from "pg";
import { discoveryStateHash, type DiscoveryStateInput } from "./state.ts";

/** The frozen v1 contract name. Consumers refuse anything else. */
export const QUALIFICATION_VIEW = "v_opportunity_for_qualification_v1";
export const QUALIFICATION_VIEW_VERSION = "v1";

/** Every column of the frozen view, in contract order. */
export const QUALIFICATION_COLUMNS = [
  "opportunity_id",
  "pipeline",
  "opportunity_key",
  "opportunity_status",
  "solution_status",
  "rule_id",
  "first_seen_at",
  "opportunity_updated_at",
  "opportunity_created_at",
  "company_id",
  "company_name",
  "company_domain_norm",
  "company_registry_id",
  "company_registry_type",
  "company_agency_type",
  "company_country",
  "company_country_code",
  "company_merged_into",
  "suppression_reason",
  "eligibility_version",
  "eligibility_decision",
  "eligibility_policy_version",
  "eligibility_gate_reasons",
  "eligibility_decided_by",
  "eligibility_decided_at",
  "evidence_claims_total",
  "evidence_claims_observed",
  "evidence_claims_corroborated",
  "evidence_claims_inferred",
  "evidence_claims_assumed",
  "evidence_claims_disputed",
  "evidence_contradicted_claims",
  "evidence_claims_needing_review",
  "evidence_latest_claim_at",
  "evidence_latest_observed_at",
  "provenance_sources_total",
  "provenance_source_keys",
  "provenance_latest_recorded_at",
  "provenance_records_failed",
  "rule_version",
  "last_event_sequence",
  "last_transition_actor",
] as const;

export type QualificationRow = Record<(typeof QUALIFICATION_COLUMNS)[number], unknown> & {
  opportunity_id: string;
  pipeline: string;
  opportunity_key: string;
};

const COLUMN_LIST = QUALIFICATION_COLUMNS.join(", ");

async function readRows(pool: Pool, where: string, params: unknown[]): Promise<QualificationRow[]> {
  // The view name is a module constant, never caller input: no injection
  // surface. Columns are the frozen allowlist above.
  const r = await pool.query(
    `select ${COLUMN_LIST} from public.${QUALIFICATION_VIEW} ${where}`,
    params as never[],
  );
  return r.rows as QualificationRow[];
}

/** One opportunity's current qualification row, or null when it does not exist. */
export async function readQualificationRow(
  pool: Pool,
  opportunityId: string,
): Promise<QualificationRow | null> {
  const rows = await readRows(pool, "where opportunity_id = $1", [opportunityId]);
  return rows[0] ?? null;
}

export interface QualificationListFilter {
  pipeline?: "agency_partner" | "direct_client";
  /** When false (default), suppressed rows are included but flagged; pass true to hide them. */
  hideSuppressed?: boolean;
  limit?: number;
  offset?: number;
}

/** Paginated read of the current qualification state. Projection; never writes. */
export async function listQualificationRows(
  pool: Pool,
  filter: QualificationListFilter = {},
): Promise<{ total: number; rows: QualificationRow[] }> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.pipeline !== undefined) {
    if (filter.pipeline !== "agency_partner" && filter.pipeline !== "direct_client") {
      const e = new Error("pipeline must be agency_partner or direct_client") as Error & {
        status: number;
        code: string;
      };
      e.status = 422;
      e.code = "bad_pipeline";
      throw e;
    }
    params.push(filter.pipeline);
    conds.push(`pipeline = $${params.length}`);
  }
  if (filter.hideSuppressed === true) {
    conds.push("suppression_reason is null");
  }
  const where = conds.length > 0 ? `where ${conds.join(" and ")}` : "";
  const total = await pool.query(
    `select count(*)::int as n from public.${QUALIFICATION_VIEW} ${where}`,
    params as never[],
  );
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);
  const rows = await readRows(
    pool,
    `${where} order by opportunity_created_at desc, opportunity_id asc limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, limit, offset],
  );
  return { total: (total.rows[0] as { n: number }).n, rows };
}

/** The drift-comparison hash for a view row. */
export function stateHashOf(row: QualificationRow): string {
  const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
  const str = (v: unknown): string | null =>
    v === null || v === undefined ? null : String(v);
  const input: DiscoveryStateInput = {
    opportunity_status: String(row.opportunity_status),
    solution_status: String(row.solution_status),
    rule_id: str(row.rule_id),
    company_merged_into: str(row.company_merged_into),
    suppression_reason: str(row.suppression_reason),
    eligibility_version: row.eligibility_version === null ? null : num(row.eligibility_version),
    eligibility_decision: str(row.eligibility_decision),
    eligibility_policy_version: str(row.eligibility_policy_version),
    evidence_claims_total: num(row.evidence_claims_total),
    evidence_claims_observed: num(row.evidence_claims_observed),
    evidence_claims_corroborated: num(row.evidence_claims_corroborated),
    evidence_claims_inferred: num(row.evidence_claims_inferred),
    evidence_claims_assumed: num(row.evidence_claims_assumed),
    evidence_claims_disputed: num(row.evidence_claims_disputed),
    evidence_contradicted_claims: num(row.evidence_contradicted_claims),
    evidence_claims_needing_review: num(row.evidence_claims_needing_review),
    provenance_sources_total: num(row.provenance_sources_total),
    provenance_source_keys: (row.provenance_source_keys as string[] | null) ?? null,
    provenance_records_failed: num(row.provenance_records_failed),
  };
  return discoveryStateHash(input);
}
