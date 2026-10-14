// Server-side dashboard fetchers (Postgres via service-role pool).
// Bounded result sets; every number shown comes from these queries —
// unavailable data is surfaced as empty/unavailable, never invented.

import { getPool } from "@/lib/intake/db";
import type {
  AgencyRow,
  AuditRow,
  BriefDetail,
  BriefRow,
  ClaimRow,
  DiscoveryRow,
  DraftRow,
  FailureRow,
  HypothesisRow,
  ImportBatchRow,
  OutcomeRow,
  OverviewCounts,
  ProjectRow,
  ScoreRow,
  SnapshotRow,
  SourceRow,
} from "./types";

const LIM = 500;

export async function getAgencies(q: string): Promise<AgencyRow[]> {
  const pool = getPool();
  const needle = q.trim().slice(0, 200);
  const params: unknown[] = [];
  let where = "";
  if (needle !== "") {
    params.push(`%${needle}%`);
    where =
      "where name ilike $1 or coalesce(domain_norm,'') ilike $1 or country ilike $1";
  }
  params.push(LIM);
  const r = await pool.query(
    `select id, name, domain_norm, registry_id, agency_type, country,
            country_code, region, website_url, discovery_status, created_at
     from public.company ${where} order by created_at desc limit $${params.length}`,
    params,
  );
  return r.rows;
}

export interface AliasRow {
  alias_type: string;
  alias_value: string;
  canonical_name: string;
}

export async function getAliases(): Promise<AliasRow[]> {
  const r = await getPool().query(
    `select a.alias_type, a.alias_value, c.name as canonical_name
     from public.company_alias a
     join public.company c on c.id = a.canonical_company_id
     order by a.created_at desc limit ${LIM}`,
  );
  return r.rows;
}

export interface ResearchRunRow {
  id: string;
  company_name: string;
  status: string;
  failure_class: string | null;
  attempts: number;
  started_at: string;
}

export async function getResearchRuns(): Promise<ResearchRunRow[]> {
  const r = await getPool().query(
    `select r.id, c.name as company_name, r.status, r.failure_class,
            r.attempts, r.started_at
     from public.research_run r
     join public.company c on c.id = r.company_id
     order by r.started_at desc limit ${LIM}`,
  );
  return r.rows;
}

export async function getDiscovery(): Promise<DiscoveryRow[]> {  const r = await getPool().query(
    `select d.id, c.name as company_name, d.source_key, s.platform as source_platform,
            d.collection_method, d.retrieval_status, d.retrieved_at, d.note
     from public.discovery_record d
     join public.company c on c.id = d.company_id
     left join public.source s on s.key = d.source_key
     order by d.retrieved_at desc limit ${LIM}`,
  );
  return r.rows;
}

export async function getSnapshots(): Promise<SnapshotRow[]> {
  const r = await getPool().query(
    `select s.id, c.name as company_name, s.source_key, s.url, s.fetched_at,
            s.sha256, s.retention_class, s.suppressed, s.content_excerpt as excerpt
     from public.snapshot s join public.company c on c.id = s.company_id
     order by s.fetched_at desc limit ${LIM}`,
  );
  return r.rows;
}

export async function getClaims(status?: string): Promise<ClaimRow[]> {
  const allowed = ["observed", "verified", "corroborated", "inferred", "assumed", "disputed", "withdrawn", "superseded"];
  const params: unknown[] = [];
  let where = "";
  if (status && allowed.includes(status)) {
    params.push(status);
    where = "where c.claim_status = $1";
  }
  params.push(LIM);
  const r = await getPool().query(
    `select c.id, co.name as company_name, c.claim_text, c.claim_status,
            c.source_reliability, c.info_credibility, s.source_key,
            s.url as snapshot_url, s.fetched_at, c.observed_at, c.expires_at,
            (c.expires_at is not null and c.expires_at < now()) as stale
     from public.claim c
     join public.company co on co.id = c.company_id
     join public.snapshot s on s.id = c.snapshot_id
     ${where} order by c.created_at desc limit $${params.length}`,
    params,
  );
  return r.rows;
}

export async function getHypotheses(): Promise<HypothesisRow[]> {
  const r = await getPool().query(
    `select h.id, c.name as company_name, h.title, h.opportunity_category,
            h.status, h.rule_id, h.rule_version, h.confidence_rationale, h.rejection_reason,
            count(*) filter (where he.polarity = 'supports')::int as supports,
            count(*) filter (where he.polarity = 'contradicts')::int as contradicts
     from public.hypothesis h
     join public.company c on c.id = h.company_id
     left join public.hypothesis_evidence he on he.hypothesis_id = h.id
     group by h.id, c.name order by h.created_at desc limit ${LIM}`,
  );
  return r.rows;
}

export async function getProjects(): Promise<ProjectRow[]> {
  const r = await getPool().query(
    `select p.id, h.title as hypothesis_title, c.name as company_name,
            p.title, p.feasibility, p.effort_lo_days, p.effort_hi_days,
            p.cost_low, p.cost_high, p.cost_currency, p.assumptions,
            p.capability_fit, p.validation_questions,
            coalesce(array_agg(pc.capability_key)
              filter (where pc.capability_key is not null), '{}') as capabilities
     from public.project_option p
     join public.hypothesis h on h.id = p.hypothesis_id
     join public.company c on c.id = h.company_id
     left join public.project_capability pc on pc.project_option_id = p.id
     group by p.id, h.title, c.name order by p.created_at desc limit ${LIM}`,
  );
  return r.rows;
}

export async function getScores(): Promise<ScoreRow[]> {
  const r = await getPool().query(
    `select s.id, h.title as hypothesis_title, c.name as company_name,
            s.weight_version, s.fit, s.evidence, s.opportunity, s.feasibility,
            s.timing, s.deductions, s.total, s.band, s.gates_passed, s.created_at
     from public.score_run s
     join public.hypothesis h on h.id = s.hypothesis_id
     join public.company c on c.id = h.company_id
     order by s.total desc limit ${LIM}`,
  );
  return r.rows;
}

export async function getBriefs(status?: string): Promise<BriefRow[]> {
  const allowed = ["draft", "in_review", "approved", "needs_work"];
  const params: unknown[] = [];
  let where = "";
  if (status && allowed.includes(status)) {
    params.push(status);
    where = "where b.status = $1";
  }
  params.push(LIM);
  const r = await getPool().query(
    `select b.ref, c.name as company_name, h.title as hypothesis_title,
            b.status, b.reviewer, b.decided_at, b.created_at
     from public.brief b
     join public.company c on c.id = b.company_id
     join public.hypothesis h on h.id = b.hypothesis_id
     ${where} order by b.created_at desc limit $${params.length}`,
    params,
  );
  return r.rows;
}

export async function getBrief(ref: string): Promise<BriefDetail | null> {
  const pool = getPool();
  const b = await pool.query(
    `select b.ref, c.name as company_name, h.title as hypothesis_title,
            h.id as hypothesis_id, b.status, b.reviewer, b.decided_at,
            b.created_at, b.markdown,
            s.total as score_total, s.band as score_band
     from public.brief b
     join public.company c on c.id = b.company_id
     join public.hypothesis h on h.id = b.hypothesis_id
     left join public.score_run s on s.id = b.score_run_id
     where b.ref = $1`,
    [ref],
  );
  if (b.rows.length === 0) return null;
  const drafts = await pool.query(
    `select od.id, od.channel, od.subject, c.name as company_name
     from public.outreach_draft od
     join public.brief br on br.ref = od.brief_ref
     join public.company c on c.id = br.company_id
     where od.brief_ref = $1`,
    [ref],
  );
  const outcomes = await pool.query(
    `select id, outcome, channel, sent_at_manual, rejection_code,
            recorded_by from public.outcome_log where brief_ref = $1
     order by created_at desc`,
    [ref],
  );
  return { ...b.rows[0], drafts: drafts.rows, outcomes: outcomes.rows };
}

export async function getDrafts(): Promise<DraftRow[]> {
  const r = await getPool().query(
    `select od.id, od.brief_ref, c.name as company_name, od.channel,
            od.subject, od.body
     from public.outreach_draft od
     join public.brief b on b.ref = od.brief_ref
     join public.company c on c.id = b.company_id
     order by od.created_at desc limit ${LIM}`,
  );
  return r.rows;
}

export async function getOutcomes(): Promise<OutcomeRow[]> {
  const r = await getPool().query(
    `select o.id, o.brief_ref, c.name as company_name, o.outcome, o.channel,
            o.sent_at_manual, o.rejection_code, o.note, o.recorded_by, o.created_at
     from public.outcome_log o
     join public.brief b on b.ref = o.brief_ref
     join public.company c on c.id = b.company_id
     order by o.created_at desc limit ${LIM}`,
  );
  // pg returns DATE columns as Date objects, which React cannot render.
  // Serialize at the boundary so all consumers are safe.
  return (r.rows as Record<string, unknown>[]).map((row) => ({
    ...(row as unknown as OutcomeRow),
    sent_at_manual:
      row["sent_at_manual"] instanceof Date
        ? (row["sent_at_manual"] as Date).toISOString().slice(0, 10)
        : (row["sent_at_manual"] as string | null),
  }));
}

export async function getSources(): Promise<SourceRow[]> {
  const r = await getPool().query(
    `select key, category, platform, reliability_prior, enabled, kind
     from public.source order by kind, category`,
  );
  return r.rows;
}

export async function getAudit(): Promise<AuditRow[]> {
  const r = await getPool().query(
    `select id, entity_type, entity_id, actor, transition_from,
            transition_to, reason, created_at
     from public.audit_log order by created_at desc limit 200`,
  );
  return r.rows;
}

export async function getFailures(): Promise<FailureRow[]> {
  const r = await getPool().query(
    `select id, entity_type, entity_id, cause_class, detail, resolved, occurred_at
     from public.failure_log order by occurred_at desc limit ${LIM}`,
  );
  return r.rows;
}

export async function getImportBatches(): Promise<ImportBatchRow[]> {
  const r = await getPool().query(
    `select b.id, b.filename, b.total_rows, b.status, b.created_by, b.created_at,
            count(*) filter (where r.status = 'imported')::int as imported,
            count(*) filter (where r.status = 'skipped')::int as skipped,
            count(*) filter (where r.status = 'invalid')::int as invalid
     from public.import_batch b
     left join public.import_row r on r.batch_id = b.id
     group by b.id order by b.created_at desc limit ${LIM}`,
  );
  return r.rows;
}

export async function getOverview(): Promise<OverviewCounts> {
  const pool = getPool();
  const [co, coS, cl, clS, hy, br, brS, oc, ba, fa, mg] = await Promise.all([
    pool.query("select count(*)::int as n from public.company"),
    pool.query(
      "select discovery_status as status, count(*)::int as n from public.company group by 1",
    ),
    pool.query("select count(*)::int as n from public.claim"),
    pool.query(
      "select claim_status as status, count(*)::int as n from public.claim group by 1",
    ),
    pool.query("select count(*)::int as n from public.hypothesis"),
    pool.query("select count(*)::int as n from public.brief"),
    pool.query("select status, count(*)::int as n from public.brief group by 1"),
    pool.query("select count(*)::int as n from public.outcome_log"),
    pool.query("select count(*)::int as n from public.import_batch"),
    pool.query(
      "select count(*)::int as n from public.failure_log where resolved = false",
    ),
    pool.query("select count(*)::int as n from schema_migrations"),
  ]);
  return {
    companies: co.rows[0].n,
    companiesByStatus: coS.rows,
    claims: cl.rows[0].n,
    claimsByStatus: clS.rows,
    hypotheses: hy.rows[0].n,
    briefs: br.rows[0].n,
    briefsByStatus: brS.rows,
    outcomes: oc.rows[0].n,
    batches: ba.rows[0].n,
    failuresOpen: fa.rows[0].n,
    migrationsApplied: mg.rows[0].n,
  };
}
