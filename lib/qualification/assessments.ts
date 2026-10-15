// Assessment recording: the full score → snapshot → assess pipeline (Part 2, §10).
//
// One operator-invoked run takes a versioned Discovery opportunity, preserves
// its evidence snapshot, evaluates gates, computes permitted dimensions, and
// stores the immutable assessment — or records WHY it stopped (gate outcome,
// insufficient coverage). Everything consequential is part of the idempotency
// key: same key + same request returns the recorded result; same key +
// different request is a 409 conflict. Immutable rows are never overwritten:
// a re-run appends a new assessment version.
//
// Staleness (§10, last paragraph): an assessment goes stale when the evidence
// changed (snapshot hash moved), any cited version was superseded, the
// opportunity left the view, or suppression appeared. Staleness is REPORTED;
// reevaluation is an explicit operator act, never automatic.

import type { Pool, PoolClient } from "pg";
import {
  ensureCase,
  getCase,
  recordAssessment as appendAssessment,
  recordSnapshot,
  withIdempotency,
} from "./cases.ts";
import { buildEvidenceBundle, type EvidenceBundle } from "./evidence.ts";
import { readQualificationRow, stateHashOf } from "./view.ts";
import { approvedServices, readPolicy, type CapacityDefinition, type Dimension, type RubricDimension, type ServiceDefinition } from "./policy.ts";
import { score, type OperatorAnswers, type ScoreResult } from "./scoring.ts";
import { proposeResearchTasks, saveResearchTasks } from "./research.ts";

export interface AssessmentError {
  status: number;
  code: string;
  message: string;
}

const fail = (status: number, code: string, message: string): AssessmentError => ({
  status,
  code,
  message,
});

export interface RunAssessmentInput {
  opportunityId: string;
  policyVersion: string;
  catalogVersion: string;
  rubricVersion: string;
  capacityVersion?: string | null;
  capacity?: CapacityDefinition | null;
  operatorAnswers?: OperatorAnswers;
  asOf?: string;
  requiredUsable?: number;
  actor: string;
  idempotencyKey?: string;
}

export interface AssessmentRecord {
  assessmentId: string;
  version: number;
  caseId: string;
  snapshotId: string;
  outcome: ScoreResult["outcome"];
  composite: number | null;
  band: string | null;
  replayed: boolean;
}

/** Reference rows that must exist and be usable for an assessment run. */
async function requireActiveReference(
  db: Pool | PoolClient,
  kind: "policy" | "service_catalog" | "rubric" | "capacity",
  version: string,
): Promise<void> {
  const r = await db.query("select status from p2.reference_version where kind = $1 and version = $2", [kind, version]);
  if (r.rows.length === 0) throw fail(422, "unknown_reference_version", `${kind} version '${version}' is not registered`);
  if (r.rows[0].status === "retired") throw fail(409, "retired_reference_version", `${kind} version '${version}' is retired`);
  if (r.rows[0].status !== "active") {
    throw fail(
      409,
      "reference_not_active",
      `${kind} version '${version}' is '${r.rows[0].status}' — only active versions back assessments (publish explicitly)`,
    );
  }
}

async function readRubric(db: Pool | PoolClient, version: string): Promise<Record<Dimension, RubricDimension>> {
  const r = await db.query("select dimensions from p2.rubric where rubric_version = $1", [version]);
  if (r.rows.length === 0) throw fail(404, "rubric_not_found", "rubric version is not stored");
  return r.rows[0].dimensions as Record<Dimension, RubricDimension>;
}

async function readCapacity(
  db: Pool | PoolClient,
  version: string | null | undefined,
): Promise<{ version: string; definition: CapacityDefinition } | null> {
  if (!version) return null;
  const r = await db.query("select definition from p2.capacity_profile where capacity_version = $1", [version]);
  if (r.rows.length === 0) throw fail(404, "capacity_not_found", "capacity version is not stored");
  return { version, definition: r.rows[0].definition as CapacityDefinition };
}

/**
 * Run the full pipeline for one opportunity. Operator-invoked (route, script,
 * or test). Returns the recorded assessment; with an idempotency key the
 * second identical call returns the same record with replayed: true.
 */
export async function runAssessment(pool: Pool, input: RunAssessmentInput): Promise<AssessmentRecord> {
  if (!(input.actor ?? "").trim()) throw fail(422, "actor_required", "acting operator identity is required");
  const asOf = input.asOf ?? new Date().toISOString();
  const request = {
    opportunityId: input.opportunityId,
    policyVersion: input.policyVersion,
    catalogVersion: input.catalogVersion,
    rubricVersion: input.rubricVersion,
    capacityVersion: input.capacityVersion ?? null,
    operatorAnswers: input.operatorAnswers ?? {},
    asOf,
    requiredUsable: input.requiredUsable ?? 1,
  };
  const run = async (): Promise<Omit<AssessmentRecord, "replayed">> => {
    const row = await readQualificationRow(pool, input.opportunityId);
    if (!row) throw fail(404, "opportunity_not_found", "opportunity is not visible in the qualification view");
    await requireActiveReference(pool, "policy", input.policyVersion);
    await requireActiveReference(pool, "service_catalog", input.catalogVersion);
    await requireActiveReference(pool, "rubric", input.rubricVersion);
    if (input.capacityVersion) await requireActiveReference(pool, "capacity", input.capacityVersion);

    const policy = await readPolicy(pool, input.policyVersion);
    const services: ServiceDefinition[] = await approvedServices(pool, input.catalogVersion);
    const rubric = await readRubric(pool, input.rubricVersion);
    const capacity = await readCapacity(pool, input.capacityVersion ?? null);
    const bundle: EvidenceBundle = await buildEvidenceBundle(pool, String(row.company_id), {
      asOf,
      signalMap: policy.signalMap,
      freshnessDefaultDays: policy.freshnessDefaultDays,
    });

    const result = score({
      row,
      bundle,
      policy,
      policyVersion: input.policyVersion,
      services,
      catalogVersion: input.catalogVersion,
      rubric,
      rubricVersion: input.rubricVersion,
      capacity,
      operatorAnswers: input.operatorAnswers,
      asOf,
      requiredUsable: input.requiredUsable ?? 1,
      // Real exclusion input: the company's recorded business relationships
      // (display/review rows, zero merge semantics — read here, never altered).
      relationships: await relatedBusinesses(pool, String(row.company_id ?? "")),
    });

    // Case + snapshot first (the assessment cites both).
    const { kase } = await ensureCase(pool, row, input.actor);
    const snap = await recordSnapshot(pool, kase.case_id, row, input.actor, "assessment-input");
    // Race guard: exclusion or supersession may have landed while scoring.
    // A suppressed opportunity must never receive a current eligible result.
    await assertAssessmentCurrent(pool, input.opportunityId, result.outcome);
    const negative = await pool.query(
      "select finding_id, question from p2.negative_finding where case_id = $1 and snapshot_id = $2",
      [kase.case_id, snap.snapshotId],
    );
    result.negativeEvidence = (negative.rows as { finding_id: string; question: string }[]).map((n) => ({
      findingId: n.finding_id,
      question: n.question,
    }));

    const appended = await appendAssessment(pool, kase.case_id, {
      rubricVersion: input.rubricVersion,
      policyVersion: input.policyVersion,
      serviceCatalogVersion: input.catalogVersion,
      assessment: JSON.parse(JSON.stringify(result)) as Record<string, unknown>,
      inputSnapshotId: snap.snapshotId,
      actor: input.actor,
      note: `gates:${result.outcome} composite:${result.composite ?? "none"} band:${result.band ?? "none"}`,
      // Reproducibility columns ride the INSERT (the row is append-only).
      // snapshot_hash is the DISCOVERY-state hash (same scheme as the case's
      // discovery_state_hash, so staleness compares like with like); the
      // score's own input hash lives inside the assessment JSON.
      capacityVersion: input.capacityVersion ?? null,
      asOf,
      snapshotHash: stateHashOf(row),
      codeVersion: result.engineVersion,
    });

    // Propose research for whatever remains unanswered (idempotent per question).
    const proposed = proposeResearchTasks(result, {
      availableSources: bundle.usable.map((i) => i.sourceKey ?? "unknown"),
    });
    await saveResearchTasks(pool, kase.case_id, snap.snapshotId, proposed);

    return {
      assessmentId: appended.assessmentId,
      version: appended.version,
      caseId: kase.case_id,
      snapshotId: snap.snapshotId,
      outcome: result.outcome,
      composite: result.composite,
      band: result.band,
    };
  };

  if (!input.idempotencyKey) {
    return { ...(await run()), replayed: false };
  }
  // Every consequential input is part of the keyed request (actor included):
  // same key + same request replays, same key + different request conflicts.
  const { result, replayed } = await withIdempotency(
    pool,
    "assessment",
    input.idempotencyKey,
    { ...request, actor: input.actor },
    async () => run(),
  );
  return { ...(result as Omit<AssessmentRecord, "replayed">), replayed };
}

export interface StalenessReport {
  assessmentId: string;
  stale: boolean;
  reasons: string[];
}

/**
 * Report whether an assessment still describes current truth. Reasons name
 * the exact change (evidence moved, version superseded, suppression
 * appeared, opportunity gone). Reevaluation is separate and explicit.
 */
export async function assessmentStaleness(pool: Pool, assessmentId: string): Promise<StalenessReport> {
  const a = await pool.query(
    `select a.assessment_id, a.case_id, a.policy_version, a.service_catalog_version,
            a.rubric_version, a.capacity_version, a.snapshot_hash, a.as_of,
            c.discovery_opportunity_id
     from p2.case_assessment a
     join p2.case c on c.case_id = a.case_id
     where a.assessment_id = $1`,
    [assessmentId],
  );
  if (a.rows.length === 0) throw fail(404, "assessment_not_found", "assessment not found");
  const row = a.rows[0] as Record<string, unknown>;
  const reasons: string[] = [];
  const oppId = row.discovery_opportunity_id as string;
  const view = await readQualificationRow(pool, oppId);
  if (!view) {
    reasons.push("opportunity no longer visible in the qualification view");
  } else {
    if (stateHashOf(view) !== (row.snapshot_hash as string)) {
      reasons.push("Discovery state moved since the assessment snapshot (evidence or lifecycle changed)");
    }
    if (String(view.suppression_reason ?? "") !== "") {
      reasons.push(`suppression now present: ${String(view.suppression_reason)}`);
    }
  }
  for (const [kind, version] of [
    ["policy", row.policy_version],
    ["service_catalog", row.service_catalog_version],
    ["rubric", row.rubric_version],
  ] as const) {
    if (!version) continue;
    const ref = await pool.query("select status from p2.reference_version where kind = $1 and version = $2", [
      kind,
      version as string,
    ]);
    if (ref.rows.length === 0 || ref.rows[0].status !== "active") {
      reasons.push(`${kind} version '${String(version)}' is no longer active`);
    }
  }
  if (row.capacity_version) {
    const ref = await pool.query("select status from p2.reference_version where kind = 'capacity' and version = $1", [
      row.capacity_version as string,
    ]);
    if (ref.rows.length === 0 || ref.rows[0].status !== "active") {
      reasons.push(`capacity version '${String(row.capacity_version)}' is no longer active`);
    }
  }
  return { assessmentId, stale: reasons.length > 0, reasons };
}

export { getCase };

/** Business relationships touching a company (either side), for the exclusion gate. */
async function relatedBusinesses(db: Pool | PoolClient, companyId: string): Promise<{ relType: string }[]> {
  if (!companyId) return [];
  const r = await db.query(
    "select rel_type from public.business_relationship where company_a = $1 or company_b = $1",
    [companyId],
  );
  return (r.rows as { rel_type: string }[]).map((x) => ({ relType: x.rel_type }));
}

/**
 * Pre-record guard against exclusion/supersession landing mid-assessment.
 * Re-reads the CURRENT view row and refuses to record an eligible result when
 * the opportunity is now suppressed or gone. Called inside runAssessment just
 * before the assessment row is appended; also exported so routes and tests
 * can assert the exact condition.
 */
export async function assertAssessmentCurrent(
  db: Pool | PoolClient,
  opportunityId: string,
  outcome: string,
): Promise<void> {
  const view = await readQualificationRow(db as Pool, opportunityId);
  if (!view) {
    throw fail(404, "opportunity_not_found", "opportunity left the qualification view during assessment");
  }
  if (view.suppression_reason !== null && view.suppression_reason !== undefined && outcome === "eligible_for_assessment") {
    throw fail(
      409,
      "suppression_changed",
      `suppression appeared during assessment (${String(view.suppression_reason)}) — an eligible result must not become current`,
    );
  }
}
