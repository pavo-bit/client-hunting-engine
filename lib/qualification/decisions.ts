// Human review decisions (Part 3, §3–§4). Immutable, audited, conflict-safe.
//
// A decision is the operator's verdict on a case, citing the exact assessment
// (and through it the snapshot) reviewed. Corrections and reconsiderations
// cite a NEW assessment — records are never edited, and one decision per
// (case, assessment) means concurrent same-assessment decisions conflict
// (409) instead of doubling.
//
// What decisions CANNOT do (enforced here, tested):
//   - override suppression or a not_eligible gate outcome (accept/defer refused);
//   - accept or defer on a stale assessment (re-run first; reject/withdraw
//     stay available because they record reality, not approval);
//   - open a second deferral while one is active, or exceed the policy's
//     deferral limits (limits come from the approved policy, never defaults).
//
// Display vocabulary (no duplicate statuses — derived, never stored):
// AwaitingAssessment / NeedsEvidence / Blocked / QualifiedForReview / Deferred /
// NotAFit / Accepted / Rejected / Withdrawn, plus Suppressed and Stale flags.

import type { Pool, PoolClient } from "pg";
import { assessmentStaleness } from "./assessments.ts";
import type { PolicyDefinition } from "./policy.ts";
import { readQualificationRow } from "./view.ts";

export interface DecisionError {
  status: number;
  code: string;
  message: string;
}

const fail = (status: number, code: string, message: string): DecisionError => ({
  status,
  code,
  message,
});

export type DecisionType = "accepted" | "rejected" | "deferred" | "withdrawn";

export interface DecideInput {
  caseId: string;
  /** Required for accepted/rejected/deferred (cite what was reviewed); optional for withdrawn. */
  assessmentId?: string | null;
  type: DecisionType;
  reason: string;
  reasonCode?: string;
  resumeAt?: string | null;
  resumeCondition?: string | null;
  actor: string;
  /** Approved policy for deferral limits; null skips numeric limits (structural rules still apply). */
  policy?: PolicyDefinition | null;
}

export interface DecisionRow {
  decision_id: string;
  case_id: string;
  assessment_id: string | null;
  decision: DecisionType;
  reason: string;
  reason_code: string | null;
  resume_at: string | null;
  resume_condition: string | null;
  actor: string;
  decided_at: string;
}

function toDecision(row: Record<string, unknown>): DecisionRow {
  return {
    decision_id: row.decision_id as string,
    case_id: row.case_id as string,
    assessment_id: (row.assessment_id as string | null) ?? null,
    decision: row.decision as DecisionType,
    reason: row.reason as string,
    reason_code: (row.reason_code as string | null) ?? null,
    resume_at: row.resume_at ? (row.resume_at as Date).toISOString() : null,
    resume_condition: (row.resume_condition as string | null) ?? null,
    actor: row.actor as string,
    decided_at: (row.decided_at as Date).toISOString(),
  };
}

/** Latest decision for a case, or null when no human has decided. */
export async function latestDecision(
  db: Pool | PoolClient,
  caseId: string,
): Promise<DecisionRow | null> {
  const r = await db.query(
    "select * from p2.case_decision where case_id = $1 order by decided_at desc, decision_id desc limit 1",
    [caseId],
  );
  return r.rows.length > 0 ? toDecision(r.rows[0]) : null;
}

export async function decisionHistory(db: Pool | PoolClient, caseId: string): Promise<DecisionRow[]> {
  const r = await db.query(
    "select * from p2.case_decision where case_id = $1 order by decided_at, decision_id",
    [caseId],
  );
  return (r.rows as Record<string, unknown>[]).map(toDecision);
}

/**
 * Record a human decision. Every rule below is backend-enforced (the UI may
 * mirror them, but mirroring is never the enforcement).
 */
export async function decide(db: Pool, input: DecideInput): Promise<DecisionRow> {
  if (!(input.actor ?? "").trim()) throw fail(422, "actor_required", "acting operator identity is required");
  if (!(input.reason ?? "").trim()) throw fail(422, "reason_required", "every decision requires a reason");
  if (!["accepted", "rejected", "deferred", "withdrawn"].includes(input.type)) {
    throw fail(422, "bad_decision", "decision must be accepted|rejected|deferred|withdrawn");
  }
  const needsAssessment = input.type !== "withdrawn";
  if (needsAssessment && !input.assessmentId) {
    throw fail(422, "assessment_required", `${input.type} must cite the assessment reviewed`);
  }
  const kase = await db.query("select case_id, discovery_opportunity_id from p2.case where case_id = $1", [
    input.caseId,
  ]);
  if (kase.rows.length === 0) throw fail(404, "case_not_found", "qualification case not found");
  const opportunityId = kase.rows[0].discovery_opportunity_id as string;

  // The cited assessment must belong to this case.
  let assessmentOutcome: string | null = null;
  if (input.assessmentId) {
    const a = await db.query(
      "select assessment_id, assessment from p2.case_assessment where assessment_id = $1 and case_id = $2",
      [input.assessmentId, input.caseId],
    );
    if (a.rows.length === 0) throw fail(422, "assessment_mismatch", "cited assessment does not belong to this case");
    assessmentOutcome = (a.rows[0].assessment as { outcome?: string }).outcome ?? null;
  }

  // Suppression and hard gates are never overridden by a review action.
  // Suppression is checked BEFORE staleness: when both hold, the actionable
  // truth is the suppression (a stale assessment on a suppressed case is
  // moot — the case cannot be pursued regardless of re-evaluation).
  const view = await readQualificationRow(db, opportunityId);
  const suppression = view ? String(view.suppression_reason ?? "") : "";
  if (suppression !== "") {
    if (input.type === "accepted" || input.type === "deferred") {
      throw fail(409, "suppression_active", `suppressed (${suppression}) — review cannot pursue; reject or withdraw`);
    }
  }
  // Stale assessments cannot back accept/defer (re-run first). Checked after
  // suppression so a suppressed case reports its suppression, not its age.
  if (input.assessmentId && (input.type === "accepted" || input.type === "deferred")) {
    const stale = await assessmentStaleness(db, input.assessmentId);
    if (stale.stale) {
      throw fail(409, "stale_assessment", `assessment is stale (${stale.reasons.join("; ")}) — re-run before deciding`);
    }
  }
  if (input.type === "accepted" && assessmentOutcome !== null && assessmentOutcome !== "eligible_for_assessment") {
    throw fail(409, "gate_not_eligible", `latest outcome is ${assessmentOutcome} — acceptance requires eligible_for_assessment`);
  }
  if (input.type === "deferred" && assessmentOutcome === "not_eligible") {
    throw fail(409, "gate_not_eligible", "a gate-rejected case cannot be deferred — reject or withdraw");
  }

  // Deferral discipline: one active deferral at a time (structural), numeric
  // limits only from the approved policy (never invented defaults).
  if (input.type === "deferred") {
    const prior = await latestDecision(db, input.caseId);
    if (prior?.decision === "deferred") {
      const overdue = prior.resume_at !== null && new Date(prior.resume_at) <= new Date();
      if (!overdue) {
        throw fail(409, "deferral_active", "a deferral is already active on this case — decide on it first");
      }
    }
    const limits = input.policy?.deferral;
    if (limits) {
      if (input.resumeAt) {
        const resume = new Date(input.resumeAt);
        if (Number.isNaN(resume.getTime())) throw fail(422, "bad_resume_at", "resumeAt must be an ISO timestamp");
        if (limits.maxDays !== null && limits.maxDays !== undefined) {
          const days = (resume.getTime() - Date.now()) / 86_400_000;
          if (days > limits.maxDays) {
            throw fail(409, "deferral_too_long", `policy allows at most ${limits.maxDays} days of deferral`);
          }
        }
      }
      if (limits.maxLifetime !== null && limits.maxLifetime !== undefined) {
        const count = await db.query(
          "select count(*)::int as n from p2.case_decision where case_id = $1 and decision = 'deferred'",
          [input.caseId],
        );
        if ((count.rows[0].n as number) >= limits.maxLifetime) {
          throw fail(409, "deferral_exhausted", `policy allows at most ${limits.maxLifetime} deferrals per case`);
        }
      }
    }
  }

  const client = await db.connect();
  try {
    await client.query("begin");
    try {
      let row: Record<string, unknown>;
      try {
        const ins = await client.query(
          `insert into p2.case_decision
             (case_id, assessment_id, decision, reason, reason_code, resume_at, resume_condition, actor)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning *`,
          [
            input.caseId,
            input.assessmentId ?? null,
            input.type,
            input.reason.trim().slice(0, 2000),
            input.reasonCode?.slice(0, 80) ?? null,
            input.resumeAt ?? null,
            input.resumeCondition?.trim().slice(0, 2000) ?? null,
            input.actor.trim().slice(0, 200),
          ],
        );
        row = ins.rows[0];
      } catch (e: unknown) {
        if ((e as { code?: string }).code === "23505") {
          throw fail(409, "decision_conflict", "a decision on this assessment already exists — concurrent decisions conflict; cite a new assessment to reconsider");
        }
        throw e;
      }
      // Withdrawal removes the case from pursuit: workflow moves to archived.
      if (input.type === "withdrawn") {
        await client.query("update p2.case set status = 'archived' where case_id = $1", [input.caseId]);
      }
      await client.query(
        `insert into p2.audit_event (entity_type, entity_id, action, actor, detail)
         values ('case', $1, $2, $3, $4)`,
        [
          input.caseId,
          `decision_${input.type}`,
          input.actor.trim().slice(0, 200),
          JSON.stringify({ decision_id: row.decision_id, assessment_id: input.assessmentId ?? null }),
        ],
      );
      await client.query("commit");
      return toDecision(row);
    } catch (e) {
      try {
        await client.query("rollback");
      } catch {
        /* connection already broken */
      }
      throw e;
    }
  } finally {
    client.release();
  }
}

export type DisplayState =
  | "AwaitingAssessment"
  | "NeedsEvidence"
  | "Blocked"
  | "QualifiedForReview"
  | "Deferred"
  | "NotAFit"
  | "Accepted"
  | "Rejected"
  | "Withdrawn"
  | "Suppressed";

export interface DisplayStateInput {
  caseStatus: string;
  latestDecision: DecisionRow | null;
  /** Latest assessment gate outcome, if any assessment exists. */
  latestOutcome: string | null;
  suppression: string | null;
  stale: boolean;
  deferralOverdue: boolean;
}

/**
 * Derive the operator-facing state. Pure: same inputs, same state. Suppression
 * and human verdicts precede computed outcomes; staleness is a flag, never a
 * silent state change.
 */
export function caseDisplayState(input: DisplayStateInput): { state: DisplayState; stale: boolean; overdue: boolean } {
  if (input.suppression) return { state: "Suppressed", stale: input.stale, overdue: false };
  const d = input.latestDecision;
  if (d?.decision === "withdrawn") return { state: "Withdrawn", stale: false, overdue: false };
  if (d?.decision === "accepted") return { state: "Accepted", stale: input.stale, overdue: false };
  if (d?.decision === "rejected") return { state: "Rejected", stale: false, overdue: false };
  if (d?.decision === "deferred") {
    return { state: "Deferred", stale: input.stale, overdue: input.deferralOverdue };
  }
  switch (input.latestOutcome) {
    case "not_eligible":
      return { state: "NotAFit", stale: input.stale, overdue: false };
    case "blocked":
      return { state: "Blocked", stale: input.stale, overdue: false };
    case "needs_evidence":
      return { state: "NeedsEvidence", stale: input.stale, overdue: false };
    case "eligible_for_assessment":
      return { state: "QualifiedForReview", stale: input.stale, overdue: false };
    default:
      return { state: "AwaitingAssessment", stale: false, overdue: false };
  }
}
