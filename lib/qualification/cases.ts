// Phase 2 case lifecycle (Part 1 foundation).
//
// OWNERSHIP: everything here lives in the `p2` schema. Nothing in this module
// writes to `public.*` — Phase 2 never updates Discovery-owned records. Cases
// link to Discovery by the STABLE opportunity id and key (plain values, not
// foreign keys, so Phase 2 can never block, cascade or lock a Discovery row).
//
// `status` is WORKFLOW state (where the case sits in the operator's process),
// never a qualification verdict. A verdict, when owner policy allows one,
// lives in `case_assessment` rows, which are immutable and versioned.
//
// Reference versions (policy / service_catalog / rubric / schema) are recorded
// in `p2.reference_version` before they may be cited: a new assessment may
// cite an existing version that is not retired. Unknown or retired versions
// are refused — recording decisions against phantom policy is exactly the
// fabrication this tool forbids.

import { createHash } from "crypto";
import type { Pool, PoolClient } from "pg";
import { QUALIFICATION_VIEW_VERSION, stateHashOf, type QualificationRow } from "./view.ts";

export interface IntakeError {
  status: number;
  code: string;
  message: string;
}

const fail = (status: number, code: string, message: string): IntakeError => ({
  status,
  code,
  message,
});

export interface CaseRow {
  case_id: string;
  case_ref: string;
  discovery_opportunity_id: string;
  discovery_opportunity_key: string;
  pipeline: string;
  status: string;
  discovery_updated_at: string;
  discovery_state_hash: string;
  drift_detected_at: string | null;
  latest_sequence: number;
  created_at: string;
  updated_at: string;
  created_by: string;
}

function toCase(row: Record<string, unknown>): CaseRow {
  return {
    case_id: row.case_id as string,
    case_ref: row.case_ref as string,
    discovery_opportunity_id: row.discovery_opportunity_id as string,
    discovery_opportunity_key: row.discovery_opportunity_key as string,
    pipeline: row.pipeline as string,
    status: row.status as string,
    discovery_updated_at: (row.discovery_updated_at as Date).toISOString(),
    discovery_state_hash: row.discovery_state_hash as string,
    drift_detected_at: row.drift_detected_at ? (row.drift_detected_at as Date).toISOString() : null,
    latest_sequence: Number(row.latest_sequence),
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
    created_by: row.created_by as string,
  };
}

/** Workflow edges for `p2.case.status`. Terminal assessment states stay revisable only by archiving. */
const CASE_EDGES: Record<string, string[]> = {
  discovered: ["assessing", "archived"],
  assessing: ["assessed", "rejected", "archived"],
  assessed: ["archived"],
  rejected: ["assessing", "archived"],
  archived: [],
};

/**
 * Create the case for a qualification-view row, or return the existing one.
 * Idempotent on `discovery_opportunity_id`: backfills and redeliveries converge.
 */
export async function ensureCase(
  db: Pool | PoolClient,
  row: QualificationRow,
  actor: string,
): Promise<{ kase: CaseRow; created: boolean }> {
  if (!(actor ?? "").trim()) throw fail(422, "actor_required", "acting operator identity is required");
  const hash = stateHashOf(row);
  const updatedAt = (row.opportunity_updated_at as Date)?.toISOString?.() ?? new Date(0).toISOString();
  const r = await db.query(
    `insert into p2.case
       (discovery_opportunity_id, discovery_opportunity_key, pipeline,
        discovery_updated_at, discovery_state_hash,
        latest_sequence, created_by)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (discovery_opportunity_id) do nothing
     returning *`,
    [
      row.opportunity_id,
      row.opportunity_key,
      row.pipeline,
      updatedAt,
      hash,
      Number(row.last_event_sequence ?? 0),
      actor.trim().slice(0, 200),
    ],
  );
  if (r.rows.length > 0) return { kase: toCase(r.rows[0]), created: true };
  const existing = await db.query("select * from p2.case where discovery_opportunity_id = $1", [
    row.opportunity_id,
  ]);
  return { kase: toCase(existing.rows[0]), created: false };
}

/** Read one case by its Discovery opportunity id. */
export async function getCase(db: Pool | PoolClient, opportunityId: string): Promise<CaseRow | null> {
  const r = await db.query("select * from p2.case where discovery_opportunity_id = $1", [opportunityId]);
  return r.rows.length > 0 ? toCase(r.rows[0]) : null;
}

/** Move a case along its workflow edges. Every move is audited. */
export async function setCaseStatus(
  db: Pool | PoolClient,
  caseId: string,
  to: string,
  actor: string,
): Promise<CaseRow> {
  if (!(actor ?? "").trim()) throw fail(422, "actor_required", "acting operator identity is required");
  const cur = await db.query("select * from p2.case where case_id = $1", [caseId]);
  if (cur.rows.length === 0) throw fail(404, "case_not_found", "qualification case not found");
  const from: string = cur.rows[0].status;
  if (!(CASE_EDGES[from] ?? []).includes(to)) {
    throw fail(409, "bad_case_transition", `case transition ${from} -> ${to} is not allowed`);
  }
  const r = await db.query("update p2.case set status = $2 where case_id = $1 returning *", [caseId, to]);
  await db.query(
    `insert into p2.audit_event (entity_type, entity_id, action, actor, detail)
     values ('case', $1, $2, $3, $4)`,
    [caseId, `status_${from}_to_${to}`, actor.trim().slice(0, 200), JSON.stringify({ from, to })],
  );
  return toCase(r.rows[0]);
}

/**
 * Flag drift: Discovery's current hash no longer matches what this case was
 * reconciled against. NEVER auto-cleared here — only a new assessment made
 * against a fresh snapshot may supersede it (recorded explicitly there).
 */
export async function markCaseDrift(
  db: Pool | PoolClient,
  caseId: string,
  currentHash: string,
): Promise<CaseRow> {
  const r = await db.query(
    `update p2.case
     set drift_detected_at = coalesce(drift_detected_at, now()),
         discovery_state_hash = $2
     where case_id = $1
     returning *`,
    [caseId, currentHash],
  );
  if (r.rows.length === 0) throw fail(404, "case_not_found", "qualification case not found");
  await db.query(
    `insert into p2.audit_event (entity_type, entity_id, action, actor, detail)
     values ('case', $1, 'drift_detected', 'system', $2)`,
    [caseId, JSON.stringify({ current_hash: currentHash })],
  );
  return toCase(r.rows[0]);
}

/**
 * Capture an immutable snapshot of the exact qualification-view row an
 * assessment (or a reconciliation) was made against. Idempotent on
 * (opportunity, row hash): re-capturing identical state returns the same row.
 */
export async function recordSnapshot(
  db: Pool | PoolClient,
  caseId: string,
  row: QualificationRow,
  actor: string,
  reason = "reconciliation",
): Promise<{ snapshotId: string; created: boolean }> {
  if (!(actor ?? "").trim()) throw fail(422, "actor_required", "acting operator identity is required");
  const canonical = JSON.stringify(row, Object.keys(row).sort());
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  const r = await db.query(
    `insert into p2.case_snapshot
       (case_id, opportunity_id, schema_version, row_hash, view_row, captured_by, captured_reason)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7)
     on conflict (opportunity_id, row_hash) do nothing
     returning snapshot_id`,
    [
      caseId,
      row.opportunity_id,
      QUALIFICATION_VIEW_VERSION,
      hash,
      canonical,
      actor.trim().slice(0, 200),
      reason.slice(0, 200),
    ],
  );
  if (r.rows.length > 0) return { snapshotId: r.rows[0].snapshot_id as string, created: true };
  const existing = await db.query(
    "select snapshot_id from p2.case_snapshot where opportunity_id = $1 and row_hash = $2",
    [row.opportunity_id, hash],
  );
  return { snapshotId: existing.rows[0].snapshot_id as string, created: false };
}

export interface AssessmentInput {
  rubricVersion?: string | null;
  policyVersion?: string | null;
  serviceCatalogVersion?: string | null;
  assessment: Record<string, unknown>;
  inputSnapshotId?: string | null;
  actor: string;
  note?: string;
  /** Reproducibility columns, written once at insert (the row is append-only — never updated). */
  capacityVersion?: string | null;
  asOf?: string | null;
  snapshotHash?: string | null;
  codeVersion?: string | null;
}

/** Assert a cited reference version exists and is not retired. */
async function requireUsableReference(
  db: Pool | PoolClient,
  kind: "policy" | "service_catalog" | "rubric" | "schema" | "capacity",
  version: string,
): Promise<void> {
  const r = await db.query("select status from p2.reference_version where kind = $1 and version = $2", [
    kind,
    version,
  ]);
  if (r.rows.length === 0) {
    throw fail(422, "unknown_reference_version", `${kind} version '${version}' is not registered`);
  }
  if (r.rows[0].status === "retired") {
    throw fail(409, "retired_reference_version", `${kind} version '${version}' is retired and must not back new decisions`);
  }
}

/**
 * Append one immutable assessment version. Monotone per case (N+1 under a
 * case lock); concurrent writers serialize instead of colliding.
 */
export async function recordAssessment(
  db: Pool | PoolClient,
  caseId: string,
  input: AssessmentInput,
): Promise<{ assessmentId: string; version: number }> {
  if (!(input.actor ?? "").trim()) throw fail(422, "actor_required", "acting operator identity is required");
  if (!input.assessment || typeof input.assessment !== "object") {
    throw fail(422, "bad_assessment", "assessment must be a JSON object");
  }
  for (const [kind, version] of [
    ["policy", input.policyVersion],
    ["service_catalog", input.serviceCatalogVersion],
    ["rubric", input.rubricVersion],
  ] as const) {
    if (version !== undefined && version !== null && version !== "") {
      await requireUsableReference(db, kind, version);
    }
  }
  if (input.inputSnapshotId) {
    const s = await db.query(
      "select snapshot_id from p2.case_snapshot where snapshot_id = $1 and case_id = $2",
      [input.inputSnapshotId, caseId],
    );
    if (s.rows.length === 0) throw fail(422, "unknown_snapshot", "input snapshot does not belong to this case");
  }
  const client = "connect" in db && typeof (db as Pool).connect === "function"
    ? await (db as Pool).connect()
    : null;
  const q = client ?? (db as PoolClient);
  const ownsConnection = client !== null;
  try {
    if (ownsConnection) await q.query("begin");
    try {
      const lock = await q.query("select case_id from p2.case where case_id = $1 for update", [caseId]);
      if (lock.rows.length === 0) throw fail(404, "case_not_found", "qualification case not found");
      const cur = await q.query(
        "select coalesce(max(version), 0)::int as v from p2.case_assessment where case_id = $1",
        [caseId],
      );
      const version = (cur.rows[0].v as number) + 1;
      const ins = await q.query(
        `insert into p2.case_assessment
           (case_id, version, rubric_version, policy_version, service_catalog_version,
            assessment, input_snapshot_id, decided_by, note,
            capacity_version, as_of, snapshot_hash, code_version)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         returning assessment_id`,
        [
          caseId,
          version,
          input.rubricVersion ?? null,
          input.policyVersion ?? null,
          input.serviceCatalogVersion ?? null,
          JSON.stringify(input.assessment),
          input.inputSnapshotId ?? null,
          input.actor.trim().slice(0, 200),
          input.note?.slice(0, 2000) ?? null,
          input.capacityVersion ?? null,
          input.asOf ?? null,
          input.snapshotHash ?? null,
          input.codeVersion?.slice(0, 80) ?? null,
        ],
      );
      await q.query(
        `insert into p2.audit_event (entity_type, entity_id, action, actor, detail)
         values ('case', $1, 'assessment_recorded', $2, $3)`,
        [caseId, input.actor.trim().slice(0, 200), JSON.stringify({ version })],
      );
      if (ownsConnection) await q.query("commit");
      return { assessmentId: ins.rows[0].assessment_id as string, version };
    } catch (e) {
      if (ownsConnection) {
        try {
          await q.query("rollback");
        } catch {
          /* connection already broken */
        }
      }
      throw e;
    }
  } finally {
    if (client) client.release();
  }
}

/** Register a reference version (draft by default). Activation/retirement is an explicit operator act. */
export async function registerReferenceVersion(
  db: Pool | PoolClient,
  kind: "policy" | "service_catalog" | "rubric" | "schema" | "capacity",
  version: string,
  actor: string,
  notes?: string,
): Promise<void> {
  if (!(actor ?? "").trim()) throw fail(422, "actor_required", "acting operator identity is required");
  if (!version.trim() || version.length > 80) throw fail(422, "bad_version", "version must be 1..80 characters");
  await db.query(
    `insert into p2.reference_version (kind, version, status, notes, recorded_by)
     values ($1, $2, 'draft', $3, $4)
     on conflict (kind, version) do nothing`,
    [kind, version.trim(), notes?.slice(0, 2000) ?? null, actor.trim().slice(0, 200)],
  );
}

/** Move a reference version along draft -> active -> retired. */
export async function setReferenceStatus(
  db: Pool | PoolClient,
  kind: string,
  version: string,
  to: "active" | "retired",
  actor: string,
): Promise<void> {
  if (!(actor ?? "").trim()) throw fail(422, "actor_required", "acting operator identity is required");
  const cur = await db.query("select status from p2.reference_version where kind = $1 and version = $2", [
    kind,
    version,
  ]);
  if (cur.rows.length === 0) throw fail(404, "reference_not_found", "reference version is not registered");
  const from: string = cur.rows[0].status;
  const ok = (from === "draft" && to === "active") || (from === "active" && to === "retired");
  if (!ok) throw fail(409, "bad_reference_transition", `reference transition ${from} -> ${to} is not allowed`);
  await db.query(
    `update p2.reference_version
     set status = $3,
         activated_at = case when $3 = 'active' then now() else activated_at end,
         retired_at = case when $3 = 'retired' then now() else retired_at end
     where kind = $1 and version = $2`,
    [kind, version, to],
  );
  await db.query(
    `insert into p2.audit_event (entity_type, entity_id, action, actor, detail)
     values ('reference', $1, $2, $3, $4)`,
    [`${kind}:${version}`, `reference_${from}_to_${to}`, actor.trim().slice(0, 200), JSON.stringify({ from, to })],
  );
}

/**
 * Run `fn` once per idempotency key. Same (scope, key, request hash) twice
 * returns the STORED result without re-executing; a different request hash
 * under the same key is refused (the key names one specific request).
 * `fn` runs inside a transaction: if it throws, nothing is stored and nothing
 * it wrote survives.
 */
export async function withIdempotency<T>(
  pool: Pool,
  scope: string,
  key: string,
  request: Record<string, unknown>,
  fn: (client: PoolClient) => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const canonical = JSON.stringify(request, Object.keys(request ?? {}).sort());
  const requestHash = createHash("sha256").update(canonical, "utf8").digest("hex");
  const seen = await pool.query("select request_hash, result from p2.idempotency_record where scope = $1 and key = $2", [
    scope,
    key,
  ]);
  if (seen.rows.length > 0) {
    if (seen.rows[0].request_hash !== requestHash) {
      throw fail(409, "idempotency_key_reuse", "idempotency key was already used for a different request");
    }
    return { result: seen.rows[0].result as T, replayed: true };
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      const result = await fn(client);
      await client.query(
        `insert into p2.idempotency_record (scope, key, request_hash, result)
         values ($1, $2, $3, $4)`,
        [scope, key, requestHash, JSON.stringify(result ?? null)],
      );
      await client.query("commit");
      return { result, replayed: false };
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
