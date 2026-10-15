// Research prioritization foundation (Part 2, §9). Decision-value model.
//
// Each unanswered question becomes a task with: what it asks, what it affects,
// what evidence would answer it, what changes if answered, what is uncertain,
// where the evidence might come from, what it costs, and why it is ordered
// where it is. Priority is impact-relative-to-effort over a deterministic
// heuristic — documented as an ordering aid, never as a probability or a
// verified business value.
//
// Tasks are PROPOSED (status open) by scoring and worked by the operator
// (accepted/done/dismissed). Nothing here executes research: Part 3 owns the
// research experience; this module only ensures the right questions exist in
// the right order. Manual and operator-triggered throughout.

import type { Pool, PoolClient } from "pg";
import type { ScoreResult } from "./scoring.ts";

export interface ResearchTaskRow {
  task_id: string;
  case_id: string;
  snapshot_id: string;
  question: string;
  reason_code: string;
  dimension: string | null;
  gate: string | null;
  evidence_needed: string;
  expected_impact: "high" | "medium" | "low";
  uncertainty: string;
  source_availability: string;
  effort_estimate: "low" | "medium" | "high";
  priority_explanation: string;
  status: string;
  operator_notes: string | null;
  due_at?: string | null;
}

export interface ProposedTask {
  question: string;
  reasonCode: string;
  dimension: string | null;
  gate: string | null;
  evidenceNeeded: string;
  expectedImpact: "high" | "medium" | "low";
  uncertainty: string;
  sourceAvailability: string;
  effortEstimate: "low" | "medium" | "high";
  priorityExplanation: string;
}

/**
 * Effort heuristic by evidence source: registry and directory lookups are
 * cheap; human outreach and paid sources are expensive. This table is a
 * documented ordering aid for the operator — not a measured cost, never a
 * value claim. Unknown sources default to medium (never low).
 */
const EFFORT_BY_SOURCE: Record<string, "low" | "medium" | "high"> = {
  registry: "low",
  directory: "low",
  "company-site": "medium",
  press: "medium",
  human: "high",
  paid: "high",
};

function effortFor(hint: string): "low" | "medium" | "high" {
  const h = hint.toLowerCase();
  for (const [k, v] of Object.entries(EFFORT_BY_SOURCE)) {
    if (h.includes(k)) return v;
  }
  return "medium";
}

/**
 * Derive research tasks from a score result. Deterministic: same result
 * always proposes the same tasks in the same order (impact desc, effort asc,
 * then question text for total order).
 */
export function proposeResearchTasks(
  score: ScoreResult,
  opts: { availableSources: string[] },
): ProposedTask[] {
  const tasks: ProposedTask[] = [];
  // Gate failures first: they decide eligibility, so answering them has the
  // highest decision impact.
  if (score.primaryGate) {
    const gate = score.primaryGate;
    tasks.push({
      question: `Resolve gate '${gate}' (${score.gateReasonCodes.filter(Boolean).join(", ") || "no reason code"})`,
      reasonCode: `GATE_${gate.toUpperCase()}`,
      dimension: null,
      gate,
      evidenceNeeded: gateEvidence(gate),
      expectedImpact: "high",
      uncertainty: `whether the opportunity clears '${gate}' at all`,
      sourceAvailability: opts.availableSources.join(", ") || "no approved sources registered",
      effortEstimate: effortFor(opts.availableSources.join(" ")),
      priorityExplanation: "gate failure decides eligibility — highest decision impact",
    });
  }
  for (const m of score.missingData) {
    for (const missing of m.missing) {
      tasks.push({
        question: `Supply ${missing} for dimension '${m.dimension}'`,
        reasonCode: `MISSING_${m.dimension.toUpperCase()}`,
        dimension: m.dimension,
        gate: null,
        evidenceNeeded: missing,
        expectedImpact: m.dimension === "need_strength" || m.dimension === "evidence_confidence" ? "high" : "medium",
        uncertainty: `true value of '${m.dimension}' (currently unscored, never defaulted)`,
        sourceAvailability: opts.availableSources.join(", ") || "no approved sources registered",
        effortEstimate: effortFor(missing + " " + opts.availableSources.join(" ")),
        priorityExplanation: `fills a scoring blind spot in '${m.dimension}'`,
      });
    }
  }
  if (score.contradictions.length > 0) {
    tasks.push({
      question: `Resolve ${score.contradictions.length} contradicting claim(s): ${score.contradictions.map((c) => c.claimId.slice(0, 8)).join(", ")}`,
      reasonCode: "CONTRADICTION_OPEN",
      dimension: "evidence_confidence",
      gate: "contradiction_freshness",
      evidenceNeeded: "disambiguating evidence or an explicit discount rule with rationale",
      expectedImpact: "high",
      uncertainty: "whether the supporting case survives the contradiction",
      sourceAvailability: opts.availableSources.join(", ") || "no approved sources registered",
      effortEstimate: "high",
      priorityExplanation: "open contradiction blocks scoring until resolved by explicit rule",
    });
  }
  const impactRank = { high: 0, medium: 1, low: 2 };
  const effortRank = { low: 0, medium: 1, high: 2 };
  return tasks.sort(
    (a, b) =>
      impactRank[a.expectedImpact] - impactRank[b.expectedImpact] ||
      effortRank[a.effortEstimate] - effortRank[b.effortEstimate] ||
      a.question.localeCompare(b.question),
  );
}

function gateEvidence(gate: string): string {
  switch (gate) {
    case "suppression":
      return "operator review of the suppression flag (cannot be lifted by evidence)";
    case "jurisdiction":
      return "verified country/jurisdiction for the business";
    case "exclusion":
      return "relationship review against the policy exclusion list";
    case "service_availability":
      return "an approved compatible service (catalog decision, not evidence)";
    case "identity_resolution":
      return "human identity review resolving the open conflict";
    case "evidence_sufficiency":
      return "additional approved-source evidence items";
    case "contradiction_freshness":
      return "resolving evidence or an explicit discount rule";
    default:
      return "evidence addressing the gate condition";
  }
}

/** Persist proposed tasks for a case snapshot. Duplicates (same question) are not re-created. */
export async function saveResearchTasks(
  db: Pool | PoolClient,
  caseId: string,
  snapshotId: string,
  tasks: ProposedTask[],
): Promise<{ created: number; existing: number }> {
  let created = 0;
  let existing = 0;
  for (const t of tasks) {
    const dup = await db.query(
      "select task_id from p2.research_task where case_id = $1 and question = $2 and status in ('open', 'accepted')",
      [caseId, t.question],
    );
    if (dup.rows.length > 0) {
      existing += 1;
      continue;
    }
    await db.query(
      `insert into p2.research_task
         (case_id, snapshot_id, question, reason_code, dimension, gate, evidence_needed,
          expected_impact, uncertainty, source_availability, effort_estimate, priority_explanation)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        caseId,
        snapshotId,
        t.question.slice(0, 2000),
        t.reasonCode.slice(0, 80),
        t.dimension,
        t.gate,
        t.evidenceNeeded.slice(0, 2000),
        t.expectedImpact,
        t.uncertainty.slice(0, 2000),
        t.sourceAvailability.slice(0, 2000),
        t.effortEstimate,
        t.priorityExplanation.slice(0, 2000),
      ],
    );
    created += 1;
  }
  return { created, existing };
}

const TASK_EDGES: Record<string, string[]> = {
  open: ["accepted", "dismissed"],
  accepted: ["done", "dismissed"],
  done: [],
  dismissed: ["open"],
};

/**
 * Manually initiate a research task (operator-asked question, not
 * score-derived). Same validation as derived tasks; duplicates among
 * open/accepted tasks for the case are refused so the queue cannot fill with
 * repeats of one question.
 */
export async function createResearchTask(
  db: Pool | PoolClient,
  input: {
    caseId: string;
    snapshotId: string;
    question: string;
    reasonCode: string;
    dimension?: string | null;
    gate?: string | null;
    evidenceNeeded: string;
    expectedImpact: "high" | "medium" | "low";
    uncertainty: string;
    sourceAvailability: string;
    effortEstimate: "low" | "medium" | "high";
    priorityExplanation: string;
    dueAt?: string | null;
    actor: string;
  },
): Promise<ResearchTaskRow> {
  if (!(input.actor ?? "").trim()) {
    const e = new Error("acting operator identity is required") as Error & { status: number; code: string };
    e.status = 422;
    e.code = "actor_required";
    throw e;
  }
  for (const [k, v, max] of [
    ["question", input.question, 2000],
    ["evidenceNeeded", input.evidenceNeeded, 2000],
    ["uncertainty", input.uncertainty, 2000],
    ["sourceAvailability", input.sourceAvailability, 2000],
    ["priorityExplanation", input.priorityExplanation, 2000],
  ] as const) {
    if (!(v ?? "").trim() || (v as string).length > (max as number)) {
      const e = new Error(`${k} must be a 1..${max}-char string`) as Error & { status: number; code: string };
      e.status = 422;
      e.code = "bad_task_input";
      throw e;
    }
  }
  if (!["high", "medium", "low"].includes(input.expectedImpact) || !["low", "medium", "high"].includes(input.effortEstimate)) {
    const e = new Error("expectedImpact must be high|medium|low and effortEstimate low|medium|high") as Error & {
      status: number;
      code: string;
    };
    e.status = 422;
    e.code = "bad_task_input";
    throw e;
  }
  const kase = await db.query("select case_id from p2.case where case_id = $1", [input.caseId]);
  if (kase.rows.length === 0) {
    const e = new Error("qualification case not found") as Error & { status: number; code: string };
    e.status = 404;
    e.code = "case_not_found";
    throw e;
  }
  const snap = await db.query("select snapshot_id from p2.case_snapshot where snapshot_id = $1 and case_id = $2", [
    input.snapshotId,
    input.caseId,
  ]);
  if (snap.rows.length === 0) {
    const e = new Error("snapshot does not belong to this case") as Error & { status: number; code: string };
    e.status = 422;
    e.code = "unknown_snapshot";
    throw e;
  }
  const dup = await db.query(
    "select task_id from p2.research_task where case_id = $1 and question = $2 and status in ('open', 'accepted')",
    [input.caseId, input.question.trim()],
  );
  if (dup.rows.length > 0) {
    const e = new Error("an open task already asks this question for the case") as Error & {
      status: number;
      code: string;
    };
    e.status = 409;
    e.code = "duplicate_task";
    throw e;
  }
  let dueAt: string | null = null;
  if (input.dueAt !== undefined && input.dueAt !== null) {
    const d = new Date(input.dueAt);
    if (Number.isNaN(d.getTime())) {
      const e = new Error("dueAt must be an ISO timestamp or null") as Error & { status: number; code: string };
      e.status = 422;
      e.code = "bad_due_at";
      throw e;
    }
    dueAt = d.toISOString();
  }
  const r = await db.query(
    `insert into p2.research_task
       (case_id, snapshot_id, question, reason_code, dimension, gate, evidence_needed,
        expected_impact, uncertainty, source_availability, effort_estimate,
        priority_explanation, due_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning *`,
    [
      input.caseId,
      input.snapshotId,
      input.question.trim(),
      input.reasonCode.slice(0, 80),
      input.dimension ?? null,
      input.gate ?? null,
      input.evidenceNeeded.trim(),
      input.expectedImpact,
      input.uncertainty.trim(),
      input.sourceAvailability.trim(),
      input.effortEstimate,
      input.priorityExplanation.trim(),
      dueAt,
    ],
  );
  return toTaskRow(r.rows[0] as Record<string, unknown>);
}

function toTaskRow(row: Record<string, unknown>): ResearchTaskRow {
  return {
    task_id: row.task_id as string,
    case_id: row.case_id as string,
    snapshot_id: row.snapshot_id as string,
    question: row.question as string,
    reason_code: row.reason_code as string,
    dimension: (row.dimension as string | null) ?? null,
    gate: (row.gate as string | null) ?? null,
    evidence_needed: row.evidence_needed as string,
    expected_impact: row.expected_impact as "high" | "medium" | "low",
    uncertainty: row.uncertainty as string,
    source_availability: row.source_availability as string,
    effort_estimate: row.effort_estimate as "low" | "medium" | "high",
    priority_explanation: row.priority_explanation as string,
    status: row.status as string,
    operator_notes: (row.operator_notes as string | null) ?? null,
    due_at: row.due_at ? (row.due_at as Date).toISOString() : null,
  };
}

/** Read one research task (projection; never writes). */
export async function getResearchTask(
  db: Pool | PoolClient,
  taskId: string,
): Promise<ResearchTaskRow | null> {
  const r = await db.query("select * from p2.research_task where task_id = $1", [taskId]);
  return r.rows.length > 0 ? toTaskRow(r.rows[0] as Record<string, unknown>) : null;
}

/** Set or clear a task's due flag. Null clears. Past dates are allowed (they render as overdue, never auto-change state). */
export async function setResearchTaskDue(
  db: Pool | PoolClient,
  taskId: string,
  dueAt: string | null,
  actor: string,
): Promise<ResearchTaskRow> {
  if (!(actor ?? "").trim()) {
    const e = new Error("acting operator identity is required") as Error & { status: number; code: string };
    e.status = 422;
    e.code = "actor_required";
    throw e;
  }
  let parsed: string | null = null;
  if (dueAt !== null) {
    const d = new Date(dueAt);
    if (Number.isNaN(d.getTime())) {
      const e = new Error("dueAt must be an ISO timestamp or null") as Error & { status: number; code: string };
      e.status = 422;
      e.code = "bad_due_at";
      throw e;
    }
    parsed = d.toISOString();
  }
  const r = await db.query("update p2.research_task set due_at = $2 where task_id = $1 returning *", [taskId, parsed]);
  if (r.rows.length === 0) {
    const e = new Error("research task not found") as Error & { status: number; code: string };
    e.status = 404;
    e.code = "task_not_found";
    throw e;
  }
  return toTaskRow(r.rows[0] as Record<string, unknown>);
}

/** Operator workflow move on a research task, with notes. */
export async function setResearchTaskStatus(
  db: Pool | PoolClient,
  taskId: string,
  to: string,
  actor: string,
  notes?: string,
): Promise<ResearchTaskRow> {
  if (!(actor ?? "").trim()) {
    const e = new Error("acting operator identity is required") as Error & { status: number; code: string };
    e.status = 422;
    e.code = "actor_required";
    throw e;
  }
  const cur = await db.query("select * from p2.research_task where task_id = $1", [taskId]);
  if (cur.rows.length === 0) {
    const e = new Error("research task not found") as Error & { status: number; code: string };
    e.status = 404;
    e.code = "task_not_found";
    throw e;
  }
  const from: string = cur.rows[0].status;
  if (!(TASK_EDGES[from] ?? []).includes(to)) {
    const e = new Error(`research task transition ${from} -> ${to} is not allowed`) as Error & {
      status: number;
      code: string;
    };
    e.status = 409;
    e.code = "bad_task_transition";
    throw e;
  }
  const r = await db.query(
    `update p2.research_task set status = $2, operator_notes = coalesce($3, operator_notes)
     where task_id = $1 returning *`,
    [taskId, to, notes?.slice(0, 2000) ?? null],
  );
  return toTaskRow(r.rows[0] as Record<string, unknown>);
}
