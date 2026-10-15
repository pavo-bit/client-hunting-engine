// Operator-invoked reconciliation (Part 1 foundation).
//
// THREE DISTINCT OPERATIONS — kept apart on purpose, never automatic, never
// scheduled. Each is a plain function (or script command); nothing in this
// repository calls them except an explicit operator action:
//
//   1. consume  — claim pending events for one consumer and apply them;
//   2. backfill — create cases for qualification-view rows that have none
//                  (covers opportunities that predate the outbox, and any row
//                  whose events were never delivered);
//   3. reconcile — compare every case against the CURRENT view: flag drift
//                  when Discovery moved on, report orphaned cases whose
//                  opportunity vanished from the view.
//
// Historical REPLAY is a fourth, read-only operation: it reconstructs a past
// state from retained `case_snapshot` rows plus outbox payloads, never from
// the current view alone. `replayCase` below reads that retained history.
//
// Drift is NEVER auto-cleared: once flagged, only a new assessment recorded
// against a fresh snapshot supersedes it (an explicit human act, not a sync).

import type { Pool } from "pg";
import { applyClaimedEvent, claimEvents, consumerWatermark } from "./events.ts";
import { ensureCase, markCaseDrift, recordSnapshot, withIdempotency } from "./cases.ts";
import { listQualificationRows, readQualificationRow, stateHashOf } from "./view.ts";

export interface ConsumeReport {
  consumer: string;
  claimed: number;
  alreadySeen: number;
  applied: number;
  rejected: number;
  lastOutboxId: number;
  unsettled: number;
}

/** Claim and apply one batch of pending events. Operator-invoked. */
export async function consumePendingEvents(
  pool: Pool,
  consumer: string,
  actor: string,
  batch = 50,
): Promise<ConsumeReport> {
  const claimed = await claimEvents(pool, consumer, batch);
  let applied = 0;
  let rejected = 0;
  let alreadySeen = 0;
  for (const event of claimed) {
    if (event.alreadySeen) alreadySeen += 1;
    const outcome = await applyClaimedEvent(pool, consumer, event, actor);
    if (outcome === "applied") applied += 1;
    else rejected += 1;
  }
  const wm = await consumerWatermark(pool, consumer);
  const unsettled = await pool.query(
    "select count(*)::int as n from p2.event_inbox where consumer_name = $1 and status = 'claimed'",
    [consumer],
  );
  return {
    consumer,
    claimed: claimed.length,
    alreadySeen,
    applied,
    rejected,
    lastOutboxId: wm.lastOutboxId,
    unsettled: unsettled.rows[0].n as number,
  };
}

export interface BackfillReport {
  checked: number;
  casesCreated: number;
  snapshotsRecorded: number;
}

/**
 * Create cases for every qualification-view row that has none. Idempotent:
 * re-running creates nothing new and records no duplicate snapshots.
 * Operator-invoked (also used for the initial import of pre-outbox history).
 */
export async function backfillCases(
  pool: Pool,
  actor: string,
  pipeline?: "agency_partner" | "direct_client",
): Promise<BackfillReport> {
  let checked = 0;
  let casesCreated = 0;
  let snapshotsRecorded = 0;
  let offset = 0;
  for (;;) {
    const page = await listQualificationRows(pool, { pipeline, limit: 200, offset });
    if (page.rows.length === 0) break;
    for (const row of page.rows) {
      checked += 1;
      const { kase, created } = await ensureCase(pool, row, actor);
      if (created) casesCreated += 1;
      const snap = await recordSnapshot(pool, kase.case_id, row, actor, "backfill");
      if (snap.created) snapshotsRecorded += 1;
    }
    offset += page.rows.length;
    if (offset >= page.total) break;
  }
  return { checked, casesCreated, snapshotsRecorded };
}

export interface ReconcileReport {
  casesChecked: number;
  drifted: number;
  orphaned: string[];
}

/**
 * Compare every case against the current view. Flags drift; reports cases
 * whose opportunity no longer appears in the view (removed or merged away —
 * the case is kept, the operator decides). Read-mostly: writes only drift
 * flags and audit rows. Operator-invoked.
 */
export async function reconcileCases(pool: Pool): Promise<ReconcileReport> {
  const all = await pool.query("select case_id, discovery_opportunity_id, discovery_state_hash from p2.case");
  let drifted = 0;
  const orphaned: string[] = [];
  for (const c of all.rows as { case_id: string; discovery_opportunity_id: string; discovery_state_hash: string }[]) {
    const row = await readQualificationRow(pool, c.discovery_opportunity_id);
    if (!row) {
      orphaned.push(c.case_id);
      await pool.query(
        `insert into p2.audit_event (entity_type, entity_id, action, actor, detail)
         values ('case', $1, 'reconcile_orphaned', 'system', $2)`,
        [c.case_id, JSON.stringify({ opportunity_id: c.discovery_opportunity_id })],
      );
      continue;
    }
    if (stateHashOf(row) !== c.discovery_state_hash) {
      await markCaseDrift(pool, c.case_id, stateHashOf(row));
      drifted += 1;
    }
  }
  return { casesChecked: all.rows.length, drifted, orphaned };
}

export interface CaseReplay {
  caseId: string;
  snapshots: { snapshotId: string; schemaVersion: string; rowHash: string; capturedAt: string; reason: string }[];
  assessments: { assessmentId: string; version: number; decidedBy: string; decidedAt: string }[];
}

/** Reconstruct a case's recorded history from retained rows (read-only). */
export async function replayCase(pool: Pool, caseId: string): Promise<CaseReplay> {
  const kase = await pool.query("select case_id from p2.case where case_id = $1", [caseId]);
  if (kase.rows.length === 0) {
    const e = new Error("qualification case not found") as Error & { status: number; code: string };
    e.status = 404;
    e.code = "case_not_found";
    throw e;
  }
  const snaps = await pool.query(
    `select snapshot_id, schema_version, row_hash, captured_at, captured_reason
     from p2.case_snapshot where case_id = $1 order by captured_at, snapshot_id`,
    [caseId],
  );
  const assess = await pool.query(
    `select assessment_id, version, decided_by, decided_at
     from p2.case_assessment where case_id = $1 order by version`,
    [caseId],
  );
  return {
    caseId,
    snapshots: (snaps.rows as Record<string, unknown>[]).map((s) => ({
      snapshotId: s.snapshot_id as string,
      schemaVersion: s.schema_version as string,
      rowHash: s.row_hash as string,
      capturedAt: (s.captured_at as Date).toISOString(),
      reason: s.captured_reason as string,
    })),
    assessments: (assess.rows as Record<string, unknown>[]).map((a) => ({
      assessmentId: a.assessment_id as string,
      version: a.version as number,
      decidedBy: a.decided_by as string,
      decidedAt: (a.decided_at as Date).toISOString(),
    })),
  };
}

/**
 * One idempotent operator run: consume, backfill, reconcile — in that order,
 * under one idempotency key when the caller supplies it. Without a key the
 * three steps still run, but a repeated invocation repeats the work (each
 * step is itself idempotent, so repeating is safe, just not free).
 */
export async function reconcileAll(
  pool: Pool,
  input: { consumer: string; actor: string; idempotencyKey?: string },
): Promise<{ consume: ConsumeReport; backfill: BackfillReport; reconcile: ReconcileReport }> {
  const request = { consumer: input.consumer, actor: input.actor };
  const run = async (): Promise<{
    consume: ConsumeReport;
    backfill: BackfillReport;
    reconcile: ReconcileReport;
  }> => {
    const consume = await consumePendingEvents(pool, input.consumer, input.actor);
    const backfill = await backfillCases(pool, input.actor);
    const reconcile = await reconcileCases(pool);
    return { consume, backfill, reconcile };
  };
  if (!input.idempotencyKey) {
    return run();
  }
  const { result } = await withIdempotency(pool, "reconcile", input.idempotencyKey, request, async () => run());
  return result as { consume: ConsumeReport; backfill: BackfillReport; reconcile: ReconcileReport };
}


// Re-exported so operator tooling imports from one place.
export { ackEvent } from "./events.ts";
