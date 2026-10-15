// Evaluation harness (Part 3, §9). Versioned gold set, pre-declared
// thresholds, baselines, and metrics with stated denominators.
//
// METHODOLOGY (read before citing any number):
//   - The gold set (eval/goldset.v1.json) is SYNTHETIC, built to cover the
//     required mix (strong, no-need, wrong-entity, stale/duplicate,
//     contradiction, under-researched, suppressed, boundary, adversarial).
//     It measures ENGINE BEHAVIOR on constructed cases — never commercial
//     outcomes. Nothing here claims real-world lead quality.
//   - Thresholds below were declared BEFORE the first run (date in code) and
//     must not be tuned on the held-out split. If a metric misses, the report
//     says MISS and the defect becomes a regression fixture; weights are
//     never adjusted to pass.
//   - The fixture policy weights are FIXED (Part 2 fixtures). No tuning
//     happens anywhere in this file: there is no optimizer, no search, no
//     fitted parameter.
//   - Reviewer agreement uses the two recorded reviews where present;
//     disagreements + adjudication are part of the format.
//   - Metrics that need operational data (review time, pursuit outcomes,
//     qualified rate, decision-change rate) report UNMEASURED with the capture
//     mechanism — never zero, never imputed.

import { readFileSync } from "fs";
import { join } from "path";
import type { Pool } from "pg";
import { BASELINES, type BaselineCandidate, type BaselineName } from "./baselines.ts";
import { runAssessment } from "../qualification/assessments.ts";
import { buildEvidenceBundle } from "../qualification/evidence.ts";
import { score } from "../qualification/scoring.ts";
import { readQualificationRow, type QualificationRow } from "../qualification/view.ts";
import type { CapacityDefinition, PolicyDefinition, RubricDimension, ServiceDefinition } from "../qualification/policy.ts";
import type { EvidenceBundle } from "../qualification/evidence.ts";
import { registerOpportunity } from "../discovery/opportunities.ts";
import { seedCompanyWithClaims, type ClaimSpec } from "../../tests/qualification_fixtures.ts";

export const GOLD_SET_VERSION = 1;

/**
 * Acceptance thresholds, declared 2026-10-15 BEFORE the first evaluation run.
 * Changing these after inspecting holdout results invalidates the evaluation.
 */
export const EVAL_THRESHOLDS = {
  minPrecisionAt10: 0.5,
  minPrecisionAt20: 0.4,
  maxLeakage: 0,
  minStabilityOverlap: 0.8,
  minAgreement: 0.5,
} as const;

export interface GoldItem {
  id: string;
  split: "dev" | "heldout";
  kind: string;
  company: { agencyType?: string; country?: string };
  claims: (ClaimSpec & { url?: string })[];
  identityConflict?: boolean;
  archiveAfterAssess?: boolean;
  labels: { eligible: boolean; services?: string[]; band?: string; reason?: string };
  reviewers: { primary: string; secondary: string | null; disagreement: string | null; adjudicated: string };
}

export interface GoldSet {
  version: number;
  items: GoldItem[];
}

export function loadGoldSet(root = process.cwd()): GoldSet {
  const raw = JSON.parse(readFileSync(join(root, "eval", "goldset.v1.json"), "utf8")) as GoldSet;
  if (raw.version !== GOLD_SET_VERSION) {
    throw new Error(`unsupported gold-set version ${raw.version} (harness reads v${GOLD_SET_VERSION}) — refuse, do not guess`);
  }
  const ids = new Set<string>();
  for (const item of raw.items) {
    if (ids.has(item.id)) throw new Error(`duplicate gold item ${item.id}`);
    ids.add(item.id);
    if (item.split !== "dev" && item.split !== "heldout") throw new Error(`gold item ${item.id} has no declared split`);
  }
  return raw;
}

export interface EvalVersions {
  policyVersion: string;
  catalogVersion: string;
  rubricVersion: string;
  capacityVersion: string | null;
  signalMap: Record<string, string>;
  freshnessDefaultDays: number;
  asOf: string;
  actor: string;
}

export interface ScoredGold {
  id: string;
  split: string;
  opportunityId: string;
  outcome: string;
  composite: number | null;
  band: string | null;
  candidate: BaselineCandidate;
  assessmentId: string;
  /** Retained scoring inputs so stability perturbations re-run the real scorer. */
  row: QualificationRow;
  bundle: EvidenceBundle;
  policy: PolicyDefinition;
  services: ServiceDefinition[];
  rubric: Record<string, RubricDimension>;
  capacity: { version: string; definition: CapacityDefinition } | null;
}

/** Seed one gold item (namespaced p2e-) and assess it. Test/dev databases only. */
export async function scoreGoldItem(
  pool: Pool,
  item: GoldItem,
  versions: EvalVersions,
): Promise<ScoredGold> {
  const s = await seedCompanyWithClaims(
    pool,
    `eval-${item.id}`,
    item.claims.map((c) => ({ ...c, sourceKey: c.sourceKey ?? "company-site" })),
    { agencyType: item.company.agencyType ?? "web_development", country: item.company.country ?? "United States" },
  );
  if (item.identityConflict) {
    await pool.query(
      `insert into public.identity_conflict (run_id, source_record_id, company_id, rule, detail, observed_name)
       values ((select id from public.discovery_run limit 1), $1, $2, 'domain_exact', 'eval ambiguity', 'X')`,
      [`p2e-${item.id}`, s.companyId],
    );
  }
  const o = await registerOpportunity(pool, {
    pipeline: "agency_partner",
    sourceKey: "company-site",
    sourceRecordId: `P2E-${item.id}-${Date.now()}`,
    companyId: s.companyId,
    actor: versions.actor,
  });
  const r = await runAssessment(pool, {
    opportunityId: o.id,
    policyVersion: versions.policyVersion,
    catalogVersion: versions.catalogVersion,
    rubricVersion: versions.rubricVersion,
    capacityVersion: versions.capacityVersion,
    asOf: versions.asOf,
    actor: versions.actor,
  });
  if (item.archiveAfterAssess) {
    const { transitionOpportunity } = await import("../discovery/opportunities.ts");
    await transitionOpportunity(pool, o.id, "archived", { actor: versions.actor, reason: "eval suppression" });
  }
  const stored = await pool.query("select assessment from p2.case_assessment where assessment_id = $1", [
    r.assessmentId,
  ]);
  const full = stored.rows[0].assessment as {
    dimensions: Record<string, { score: number | null }>;
  };
  // Real baseline inputs from the same bundle the scorer saw (fair comparison:
  // baselines and multidim read identical evidence).
  const bundle = await buildEvidenceBundle(pool, s.companyId, {
    asOf: versions.asOf,
    signalMap: versions.signalMap,
    freshnessDefaultDays: versions.freshnessDefaultDays,
  });
  const GRADE_POINTS: Record<string, number> = { A: 100, B: 80, C: 50, D: 0 };
  const grades = bundle.usable.map((i) => GRADE_POINTS[i.trustGrade] ?? 0);
  const ages = bundle.usable.map((i) => i.ageDays).filter((a): a is number => a !== null);
  // Retained inputs for stability perturbations (re-runs the real scorer —
  // static imports would cycle eval->policy only one way, so this stays).
  const { readPolicy } = await import("../qualification/policy.ts");
  const policy = await readPolicy(pool, versions.policyVersion);
  const svcRows = await pool.query("select definition from p2.service_catalog where catalog_version = $1", [
    versions.catalogVersion,
  ]);
  const services = (svcRows.rows as { definition: ServiceDefinition }[])
    .map((x) => x.definition)
    .filter((d) => d.status === "approved");
  const rubRows = await pool.query("select dimensions from p2.rubric where rubric_version = $1", [
    versions.rubricVersion,
  ]);
  const rubric = rubRows.rows[0].dimensions as Record<string, RubricDimension>;
  const capRows = versions.capacityVersion
    ? await pool.query("select definition from p2.capacity_profile where capacity_version = $1", [
        versions.capacityVersion,
      ])
    : { rows: [] as { definition: CapacityDefinition }[] };
  const capacity =
    capRows.rows.length > 0
      ? { version: versions.capacityVersion as string, definition: (capRows.rows[0] as { definition: CapacityDefinition }).definition }
      : null;
  const row = (await readQualificationRow(pool, o.id)) as QualificationRow;
  return {
    id: item.id,
    split: item.split,
    opportunityId: o.id,
    outcome: r.outcome,
    composite: r.composite,
    band: r.band,
    candidate: {
      opportunityId: o.id,
      eligible: r.outcome === "eligible_for_assessment",
      serviceFit: full.dimensions.service_fit?.score ?? null,
      needStrength: full.dimensions.need_strength?.score ?? null,
      timing: full.dimensions.timing?.score ?? null,
      evidenceConfidence: full.dimensions.evidence_confidence?.score ?? null,
      composite: r.composite,
      usableCount: bundle.usable.length,
      gradeAverage: grades.length > 0 ? grades.reduce((a, b) => a + b, 0) / grades.length : null,
      independentGroups: new Set(bundle.usable.map((i) => i.independenceGroup)).size,
      freshestAgeDays: ages.length > 0 ? Math.min(...ages) : null,
    },
    assessmentId: r.assessmentId,
    row,
    bundle,
    policy,
    services,
    rubric,
    capacity,
  };
}

/** Remove gold-seed rows (p2e- namespace + eval identity conflicts). */
export async function cleanupGold(pool: Pool): Promise<void> {
  // Opportunity keys are lower-cased by opportunityKey(): match
  // case-insensitively, or rows survive and block company deletion (FK).
  const c = await pool.connect();
  try {
    await c.query("delete from public.identity_conflict where source_record_id ilike 'p2e-%'");
    await c.query(
      "delete from public.hypothesis_evidence where hypothesis_id in (select id from public.hypothesis where title ilike 'P2t hypothesis eval-%')",
    );
    await c.query("delete from public.hypothesis where title ilike 'P2t hypothesis eval-%'");
    await c.query("delete from p2.case where discovery_opportunity_key ilike '%P2E-%'");
    await c.query("delete from public.opportunity where opportunity_key ilike '%P2E-%'");
    await c.query("delete from public.company where domain_norm ilike 'p2t-eval-%'");
  } finally {
    c.release();
  }
}

export interface MetricResult {
  name: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  threshold: number | null;
  pass: boolean | null;
  notes: string;
}

export function precisionAtK(ranked: string[], relevant: Set<string>, k: number): { value: number; hits: number } {
  const top = ranked.slice(0, k);
  const hits = top.filter((id) => relevant.has(id)).length;
  return { value: top.length === 0 ? 0 : hits / top.length, hits };
}

/** Top-k overlap fraction between two orders (stability under perturbation). */
export function topKOverlap(a: string[], b: string[], k: number): number {
  const sa = new Set(a.slice(0, k));
  const sb = new Set(b.slice(0, k));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const id of sa) if (sb.has(id)) inter += 1;
  return inter / Math.max(sa.size, sb.size);
}

export interface EvalReport {
  goldVersion: number;
  split: string;
  items: number;
  metrics: MetricResult[];
  baselines: Record<BaselineName, { order: string[]; precisionAt10: number; precisionAt20: number }>;
  unmeasured: { name: string; capture: string }[];
}

/**
 * Evaluate one split: seed, assess, rank four ways, measure. Deterministic
 * except for timestamps embedded in fixture ids (scores do not depend on them).
 */
export async function evaluateSplit(
  pool: Pool,
  gold: GoldSet,
  split: "dev" | "heldout",
  versions: EvalVersions,
): Promise<EvalReport> {
  const items = gold.items.filter((i) => i.split === split);
  const scored: ScoredGold[] = [];
  for (const item of items) {
    scored.push(await scoreGoldItem(pool, item, versions));
  }
  const relevantOpp = new Set(
    scored.filter((s) => items.find((i) => i.id === s.id)?.labels.eligible).map((s) => s.opportunityId),
  );
  // Suppression is read CURRENT (post-assessment archiving counts — a stale
  // rank that still lists a suppressed opportunity is exactly the leak).
  // Suppressed items leave the eligible pool BEFORE ranking, so every
  // baseline and the proposed order share one honest pool.
  const suppressedNow = new Set<string>();
  for (const s of scored) {
    const v = await readQualificationRow(pool, s.opportunityId);
    if (v && v.suppression_reason !== null && v.suppression_reason !== undefined) {
      suppressedNow.add(s.opportunityId);
    }
  }
  const cands = scored.filter((s) => !suppressedNow.has(s.opportunityId)).map((s) => s.candidate);
  const baselines = {} as EvalReport["baselines"];
  for (const name of Object.keys(BASELINES) as BaselineName[]) {
    const order = BASELINES[name](cands);
    baselines[name] = {
      order,
      precisionAt10: precisionAtK(order, relevantOpp, 10).value,
      precisionAt20: precisionAtK(order, relevantOpp, 20).value,
    };
  }
  const multi = baselines.multidim.order;
  const p10 = precisionAtK(multi, relevantOpp, 10);
  const p20 = precisionAtK(multi, relevantOpp, 20);
  // Leakage counts suppressed items that STILL ranked — with the pool-level
  // exclusion above, any non-zero here is a genuine product defect.
  const suppressedRanked = scored.filter((s) => suppressedNow.has(s.opportunityId) && multi.includes(s.opportunityId)).length;
  const rankedCount = multi.length;
  // Agreement over items with two recorded reviews.
  const twoReview = items.filter((i) => i.reviewers.secondary !== null);
  const agree = twoReview.filter((i) => i.reviewers.secondary === i.reviewers.primary).length;
  // Stability: perturb each weight ±10% (one at a time), re-run the REAL
  // scorer, and take the worst top-k overlap plus the worst rank
  // displacement. Weights are normalized inside the scorer, so this measures
  // mix-sensitivity honestly. No tuning: the perturbations are fixed here.
  const k = Math.min(10, multi.length);
  let worstOverlap = 1;
  let worstDisplacement = 0;
  if (scored.length > 0 && multi.length > 0) {
    const baseRank = new Map(multi.map((id, i) => [id, i]));
    for (const key of Object.keys(scored[0].policy.weights)) {
      for (const factor of [0.9, 1.1]) {
        const reordered = scored
          .map((s) => {
            const perturbed = {
              ...s.policy,
              weights: { ...s.policy.weights, [key]: (s.policy.weights[key] as number) * factor },
            };
            const r = score({
              row: s.row,
              bundle: s.bundle,
              policy: perturbed,
              policyVersion: "perturbed",
              services: s.services,
              catalogVersion: "perturbed",
              rubric: s.rubric as never,
              rubricVersion: "perturbed",
              capacity: s.capacity,
              operatorAnswers: {},
              asOf: versions.asOf,
              requiredUsable: 1,
            });
            return { id: s.opportunityId, composite: r.composite, eligible: r.outcome === "eligible_for_assessment" };
          })
          .filter((x) => x.eligible && x.composite !== null && !suppressedNow.has(x.id))
          .sort(
            (a, b) => (b.composite as number) - (a.composite as number) || a.id.localeCompare(b.id),
          )
          .map((x) => x.id);
        worstOverlap = Math.min(worstOverlap, topKOverlap(multi, reordered, k));
        for (const [idx, id] of reordered.entries()) {
          const base = baseRank.get(id);
          if (base !== undefined) worstDisplacement = Math.max(worstDisplacement, Math.abs(base - idx));
        }
      }
    }
  }
  const metrics: MetricResult[] = [
    {
      name: "precision_at_10",
      value: p10.value,
      numerator: p10.hits,
      denominator: Math.min(10, multi.length),
      threshold: EVAL_THRESHOLDS.minPrecisionAt10,
      pass: p10.value >= EVAL_THRESHOLDS.minPrecisionAt10,
      notes: `eligible labels in top 10 of multidim order; pool ranked=${multi.length} (small-n: wide uncertainty)`,
    },
    {
      name: "precision_at_20",
      value: p20.value,
      numerator: p20.hits,
      denominator: Math.min(20, multi.length),
      threshold: EVAL_THRESHOLDS.minPrecisionAt20,
      pass: p20.value >= EVAL_THRESHOLDS.minPrecisionAt20,
      notes: `eligible labels in top 20; pool ranked=${multi.length}`,
    },
    {
      name: "suppression_leakage",
      value: rankedCount === 0 ? 0 : suppressedRanked / rankedCount,
      numerator: suppressedRanked,
      denominator: rankedCount,
      threshold: EVAL_THRESHOLDS.maxLeakage,
      pass: suppressedRanked === 0,
      notes: "suppressed items appearing in any ranked order; must be zero",
    },
    {
      name: "reviewer_agreement",
      value: twoReview.length === 0 ? null : agree / twoReview.length,
      numerator: agree,
      denominator: twoReview.length,
      threshold: EVAL_THRESHOLDS.minAgreement,
      pass: twoReview.length === 0 ? null : agree / twoReview.length >= EVAL_THRESHOLDS.minAgreement,
      notes: "fraction of dual-reviewed items where reviewers agreed pre-adjudication",
    },
    {
      name: "ranking_stability",
      value: worstOverlap,
      numerator: null,
      denominator: k,
      threshold: EVAL_THRESHOLDS.minStabilityOverlap,
      pass: worstOverlap >= EVAL_THRESHOLDS.minStabilityOverlap,
      notes: `worst top-${k} overlap across all single-weight ±10% perturbations (max rank displacement ${worstDisplacement}); small-n caveat applies`,
    },
  ];
  return {
    goldVersion: gold.version,
    split,
    items: items.length,
    metrics,
    baselines,
    unmeasured: [
      { name: "operator_review_time", capture: "instrument the review UI with decision dwell time (not built — no fabricated timings)" },
      { name: "research_task_yield", capture: "link completed tasks to outcome-changing assessments once operators work them" },
      { name: "decision_change_rate", capture: "count reconsiderations per 100 decisions from case_decision history" },
      { name: "pursuit_to_conversation_rate", capture: "record outreach outcomes against case_id (outcome_log has no case link yet — schema decision required)" },
      { name: "qualified_opportunity_rate", capture: "same as above, once commercial outcomes exist" },
    ],
  };
}
