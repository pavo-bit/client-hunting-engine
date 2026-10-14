// Score evaluation against live rows (T-011). Hard gates run FIRST: a high
// total can never override ineligibility — ineligible hypotheses get NO new
// score row. Evaluations INSERT history rows; recalculation never deletes.
// Staleness is computed at read time against evidence/audit activity.

import type { Pool } from "pg";
import {
  DEFAULT_WEIGHTS,
  SCORE_MODEL_VERSION,
  scoreOpportunity,
  type ScoreBreakdown,
  type ScoreInputs,
  type ScoreWeights,
} from "./v1";

export interface GateResult {
  id: string;
  passed: boolean;
  reason: string;
}

export interface Eligibility {
  eligible: boolean;
  gates: GateResult[];
}

const ELIGIBLE_STATUSES = ["needs_review", "validated", "generated", "deferred"];

/** Hard gates. Every failure blocks ranking with an explicit reason. */
export async function checkGates(pool: Pool, hypothesisId: string): Promise<Eligibility> {
  const gates: GateResult[] = [];
  const push = (id: string, passed: boolean, reason: string) =>
    gates.push({ id, passed, reason });

  const h = await pool.query(
    `select h.id, h.status, h.company_id,
            c.merged_into, c.name as company_name
     from public.hypothesis h join public.company c on c.id = h.company_id
     where h.id = $1`,
    [hypothesisId],
  );
  if (h.rows.length === 0) {
    return { eligible: false, gates: [{ id: "exists", passed: false, reason: "hypothesis not found" }] };
  }
  const hyp = h.rows[0];
  push(
    "hypothesis-active",
    !["rejected", "superseded"].includes(hyp.status),
    ["rejected", "superseded"].includes(hyp.status)
      ? `hypothesis is ${hyp.status} — not an active opportunity`
      : `hypothesis status ${hyp.status} is rankable (${ELIGIBLE_STATUSES.includes(hyp.status) ? "reviewed track" : "unreviewed track"})`,
  );
  push(
    "hypothesis-reviewed",
    hyp.status !== "generated",
    hyp.status === "generated"
      ? "generated but never reviewed — insufficient-evidence state until human review"
      : "has human review history or explicit deferral",
  );
  push(
    "canonical-company",
    hyp.merged_into === null,
    hyp.merged_into === null
      ? "company record is canonical"
      : "company merged away — hypotheses belong to the canonical record",
  );
  const sup = await pool.query(
    `select count(*)::int as n from public.hypothesis_evidence
     where hypothesis_id = $1 and polarity = 'supports'`,
    [hypothesisId],
  );
  push(
    "has-support",
    (sup.rows[0].n as number) > 0,
    (sup.rows[0].n as number) > 0
      ? `${sup.rows[0].n} supporting evidence link(s)`
      : "no supporting evidence — insufficient-evidence state, not rankable",
  );
  const pend = await pool.query(
    `select count(*)::int as n from public.match_candidate m
     where m.status = 'pending'
       and (m.company_a = $1 or m.company_b = $1)`,
    [hyp.company_id],
  );
  push(
    "identity-clear",
    (pend.rows[0].n as number) === 0,
    (pend.rows[0].n as number) === 0
      ? "no unresolved identity conflicts for this company"
      : `${pend.rows[0].n} pending identity candidate(s) — resolve identity first`,
  );
  const eligible = gates.every((g) => g.passed);
  return { eligible, gates };
}

async function collectInputs(pool: Pool, hypothesisId: string): Promise<ScoreInputs> {
  const h = await pool.query(
    `select h.id, h.title, h.rationale, h.validation_questions, h.rule_id,
            c.domain_norm, c.registry_id, c.country, c.country_code, c.agency_type
     from public.hypothesis h join public.company c on c.id = h.company_id
     where h.id = $1`,
    [hypothesisId],
  );
  const row = h.rows[0];
  const claims = await pool.query(
    `select cl.claim_status, cl.expires_at from public.claim cl
     join public.hypothesis_evidence he on he.claim_id = cl.id
     where he.hypothesis_id = $1 and he.polarity = 'supports'`,
    [hypothesisId],
  );
  const corroborated = claims.rows.filter((r) => r.claim_status === "corroborated").length;
  const staleSupporting = claims.rows.some(
    (r) => r.expires_at !== null && new Date(r.expires_at as string) < new Date(),
  );
  const freshSupporting = claims.rows.some(
    (r) => r.expires_at === null || new Date(r.expires_at as string) >= new Date(),
  );
  const origins = await pool.query(
    `select distinct s.source_key from public.snapshot s
     join public.claim cl on cl.snapshot_id = s.id
     join public.hypothesis_evidence he on he.claim_id = cl.id
     where he.hypothesis_id = $1 and he.polarity = 'supports'`,
    [hypothesisId],
  );
  const contra = await pool.query(
    "select count(*)::int as n from public.hypothesis_evidence where hypothesis_id = $1 and polarity = 'contradicts'",
    [hypothesisId],
  );
  const prop = await pool.query(
    `select p.feasibility from public.project_option p
     where p.hypothesis_id = $1 and p.status not in ('superseded', 'archived')
     order by p.version desc limit 1`,
    [hypothesisId],
  );
  let approvedCapability = false;
  let unapprovedCapability = false;
  if (prop.rows.length > 0) {
    const caps = await pool.query(
      `select c.status from public.project_capability k
       left join public.capability c on c.key = k.capability_key
       where k.project_option_id = (select id from public.project_option
         where hypothesis_id = $1 and status not in ('superseded','archived')
         order by version desc limit 1)`,
      [hypothesisId],
    );
    approvedCapability = caps.rows.some((r) => r.status === "approved");
    unapprovedCapability = caps.rows.some((r) => r.status !== "approved");
  }
  const freshest = await pool.query(
    `select max(s.fetched_at) as m from public.snapshot s
     join public.claim cl on cl.snapshot_id = s.id
     join public.hypothesis_evidence he on he.claim_id = cl.id
     where he.hypothesis_id = $1 and he.polarity = 'supports'`,
    [hypothesisId],
  );
  const freshestDays =
    freshest.rows[0].m === null
      ? null
      : Math.max(
          0,
          Math.floor(
            (Date.now() - new Date(freshest.rows[0].m as string).getTime()) / 86_400_000,
          ),
        );
  return {
    hasDomain: row.domain_norm !== null,
    hasRegistry: row.registry_id !== null,
    hasCountry: row.country !== null,
    hasCountryCode: row.country_code !== null,
    hasAgencyType: row.agency_type !== null,
    corroboratedClaims: corroborated,
    independentOrigins: (origins.rows.length as number),
    freshSupporting,
    staleSupporting,
    hasRule: row.rule_id !== null,
    hasQuestions:
      typeof row.validation_questions === "string" && row.validation_questions.trim() !== "",
    hasRationale: typeof row.rationale === "string" && row.rationale.trim() !== "",
    contradictCount: contra.rows[0].n as number,
    hasProposal: prop.rows.length > 0,
    proposalFeasibility: (prop.rows[0]?.feasibility as string | undefined) ?? null,
    approvedCapability,
    unapprovedCapability,
    freshestEvidenceDays: freshestDays,
  };
}

export interface EvaluationRecord {
  id: string;
  total: number;
  band: string;
  partial: boolean;
  breakdown: ScoreBreakdown;
}

/**
 * Gate, compute, and persist one evaluation. Ineligible hypotheses get NO
 * row (409 with gate reasons). History accumulates; current = latest.
 */
export async function evaluateHypothesis(
  pool: Pool,
  hypothesisId: string,
  actor: string,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): Promise<EvaluationRecord> {
  const { eligible, gates } = await checkGates(pool, hypothesisId);
  if (!eligible) {
    const e = new Error(
      `ineligible: ${gates.filter((g) => !g.passed).map((g) => `${g.id} (${g.reason})`).join("; ")}`,
    ) as Error & { status: number; code: string };
    e.status = 409;
    e.code = "gates_failed";
    throw e;
  }
  const inputs = await collectInputs(pool, hypothesisId);
  const breakdown = scoreOpportunity(inputs, weights);
  const client = await pool.connect();
  try {
    const r = await client.query(
      `insert into public.score_run
         (hypothesis_id, weight_version, fit, evidence, opportunity,
          feasibility, timing, deductions, gates_passed, gate_notes,
          explanation, model_version, detail, evaluated_at, partial)
       values ($1, 'score-v1-provisional', $2, $3, $4, $5, $6, $7, true, $8, $9,
               $10, $11, now(), $12)
       returning id, total, band, partial`,
      [
        hypothesisId,
        breakdown.fit.points,
        breakdown.evidence.points,
        breakdown.opportunity.points,
        breakdown.feasibility.points,
        breakdown.timing.points,
        breakdown.deductions.points,
        gates.map((g) => `${g.id}: ${g.reason}`).join(" | ").slice(0, 2000),
        {
          model: SCORE_MODEL_VERSION,
          weights,
          dimensions: {
            fit: breakdown.fit,
            evidence: breakdown.evidence,
            opportunity: breakdown.opportunity,
            feasibility: breakdown.feasibility,
            timing: breakdown.timing,
          },
          missing: breakdown.missing,
        },
        SCORE_MODEL_VERSION,
        JSON.stringify({
          model: SCORE_MODEL_VERSION,
          weights,
          dimensions: {
            fit: breakdown.fit,
            evidence: breakdown.evidence,
            opportunity: breakdown.opportunity,
            feasibility: breakdown.feasibility,
            timing: breakdown.timing,
          },
          deductions: breakdown.deductions,
          missing: breakdown.missing,
        }),
        breakdown.partial,
      ],
    );
    const row = r.rows[0];
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('score_run', $1, $2, null, $3, $4)`,
      [row.id, actor, `score_v1 total ${row.total}`, `evaluated ${hypothesisId}`],
    );
    return {
      id: row.id as string,
      total: row.total as number,
      band: row.band as string,
      partial: row.partial as boolean,
      breakdown,
    };
  } finally {
    client.release();
  }
}

export interface RankedRow {
  hypothesis_id: string;
  company_name: string;
  title: string;
  status: string;
  total: number;
  band: string;
  partial: boolean;
  model_version: string;
  evaluated_at: string;
  stale: boolean;
  staleReasons: string[];
}

/**
 * Ranked eligible opportunities: latest score_v1 row per hypothesis that
 * still passes gates, ordered deterministically (total desc, evaluated asc,
 * hypothesis id asc). Staleness computed against evidence/audit activity
 * after the evaluation — never stored, always fresh.
 */
export async function rankedOpportunities(pool: Pool): Promise<RankedRow[]> {
  const r = await pool.query(
    `select distinct on (s.hypothesis_id) s.hypothesis_id, s.total, s.band,
            s.partial, s.model_version, s.evaluated_at,
            h.title, h.status, c.name as company_name, c.id as company_id
     from public.score_run s
     join public.hypothesis h on h.id = s.hypothesis_id
     join public.company c on c.id = h.company_id
     where s.model_version = 'score_v1'
     order by s.hypothesis_id, s.evaluated_at desc`,
  );
  const out: RankedRow[] = [];
  for (const row of r.rows) {
    const { eligible } = await checkGates(pool, row.hypothesis_id as string);
    if (!eligible) continue;
    const staleReasons: string[] = [];
    const ev = await pool.query(
      "select max(created_at) as m from public.hypothesis_evidence where hypothesis_id = $1",
      [row.hypothesis_id],
    );
    if (ev.rows[0].m && new Date(ev.rows[0].m as string) > new Date(row.evaluated_at as string))
      staleReasons.push("evidence linked after evaluation");
    const au = await pool.query(
      `select max(a.created_at) as m from public.audit_log a
       join public.hypothesis_evidence he on he.claim_id::text = a.entity_id
       where a.entity_type in ('claim', 'hypothesis') and he.hypothesis_id = $1`,
      [row.hypothesis_id],
    );
    if (au.rows[0].m && new Date(au.rows[0].m as string) > new Date(row.evaluated_at as string))
      staleReasons.push("claim/hypothesis activity after evaluation");
    out.push({
      hypothesis_id: row.hypothesis_id as string,
      company_name: row.company_name as string,
      title: row.title as string,
      status: row.status as string,
      total: row.total as number,
      band: row.band as string,
      partial: row.partial as boolean,
      model_version: row.model_version as string,
      evaluated_at: row.evaluated_at as string,
      stale: staleReasons.length > 0,
      staleReasons,
    });
  }
  out.sort(
    (a, b) =>
      b.total - a.total ||
      (a.evaluated_at < b.evaluated_at ? -1 : a.evaluated_at > b.evaluated_at ? 1 : 0) ||
      (a.hypothesis_id < b.hypothesis_id ? -1 : 1),
  );
  return out;
}

/** Full evaluation history for one hypothesis (newest first, all versions). */
export async function scoreHistory(pool: Pool, hypothesisId: string) {
  const r = await pool.query(
    `select id, total, band, partial, model_version, weight_version,
            evaluated_at, gates_passed, gate_notes
     from public.score_run where hypothesis_id = $1 order by evaluated_at desc`,
    [hypothesisId],
  );
  return r.rows;
}
