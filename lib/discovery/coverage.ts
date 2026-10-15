// Coverage planning + task accounting (Prompt 4, blueprint §2/§3).
// Task lists, per-task yield ledgers, stopping-rule evaluation, shortfall
// reports. Stopping-rule THRESHOLDS ARE CONSTRUCTOR/PARAM INPUTS — this
// module defines no defaults (O4 open; PROPOSAL N=3 lives in docs only).
// Single-query runs (lib/discovery/run.ts) are untouched and keep working
// with no tasks. All functions take an explicit pool (repo convention).

import type { Pool } from "pg";

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

export type TaskStatus =
  | "pending"
  | "running"
  | "done"
  | "exhausted"
  | "failed"
  | "skipped_low_yield";

export interface CoverageTask {
  adapterId: string;
  queryText: string;
  limit?: number;
  maxPages?: number;
}

export interface StopConfig {
  /** Consecutive zero-new tasks before low_yield_stop. No default: caller states it. */
  lowYieldStreak: number;
  /** Per-source cap before concentration reroute. No default: caller states it. */
  concentrationCap: number;
}

export interface CoverageSummary {
  total: number;
  pending: number;
  running: number;
  done: number;
  exhausted: number;
  failed: number;
  skipped_low_yield: number;
  yield_new: number;
  yield_total: number;
}

/**
 * Plan a refresh: validate + persist 1..25 tasks against a run row.
 *
 * ATOMIC (F5): the existence check and every task INSERT run in ONE
 * transaction. Previously each INSERT auto-committed on its own, so a failure
 * on task 3 of 5 left a parent run holding a PARTIAL plan - the run looked
 * planned, would execute the wrong work, and its coverage ledger could never
 * show the caller's intended totals. Now either the whole plan is stored or
 * none of it is, and the caller is told.
 *
 * All-JS validation still runs BEFORE the transaction opens, so a malformed
 * plan costs no connection and writes nothing.
 */
export async function planRefresh(
  pool: Pool,
  runId: string,
  tasks: CoverageTask[],
): Promise<{ runId: string; planned: number }> {
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 25) {
    throw fail(422, "bad_plan", "plan must contain 1..25 coverage tasks");
  }
  for (const [i, t] of tasks.entries()) {
    if (!t.adapterId || !(t.queryText ?? "").trim() || (t.queryText ?? "").trim().length > 200) {
      throw fail(422, "bad_task", `task ${i}: adapterId and 1..200-char queryText required`);
    }
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      const run = await client.query("select id from public.discovery_run where id = $1", [runId]);
      if (run.rows.length === 0) throw fail(404, "run_not_found", "discovery run not found");
      let n = 0;
      for (const [i, t] of tasks.entries()) {
        // plan_seq preserves the operator's plan order: claiming is FIFO by
        // position, not by timestamp (one plan shares a microsecond window).
        await client.query(
          `insert into public.discovery_coverage_task (run_id, adapter_id, query_text, plan_seq)
           values ($1, $2, $3, $4)`,
          [runId, t.adapterId.slice(0, 120), t.queryText.trim(), i],
        );
        n++;
      }
      await client.query("commit");
      return { runId, planned: n };
    } catch (e) {
      try {
        await client.query("rollback");
      } catch {
        /* connection already broken; the transaction dies with it */
      }
      throw e;
    }
  } finally {
    client.release();
  }
}

/**
 * Claim the next pending task (single UPDATE … RETURNING: concurrent
 * claimants never double-claim). Marks running + started_at atomically.
 */
export async function claimTask(
  pool: Pool,
  runId: string,
): Promise<{ id: string; adapterId: string; queryText: string } | null> {
  const r = await pool.query(
    `update public.discovery_coverage_task
     set status = 'running', started_at = now(), attempts = attempts + 1
     where id = (
       select id from public.discovery_coverage_task
       where run_id = $1 and status = 'pending'
       order by plan_seq, created_at, id limit 1
       for update skip locked
     )
     returning id, adapter_id, query_text`,
    [runId],
  );
  if (r.rows.length === 0) return null;
  return {
    id: r.rows[0].id as string,
    adapterId: r.rows[0].adapter_id as string,
    queryText: r.rows[0].query_text as string,
  };
}

/** Finish a task with its yield + end-state (finished_at enforced by CHECK). */
export async function finishTask(
  pool: Pool,
  taskId: string,
  input: { status: Exclude<TaskStatus, "pending" | "running">; yieldNew?: number; yieldTotal?: number; note?: string },
): Promise<void> {
  const yn = Math.max(0, Math.trunc(input.yieldNew ?? 0));
  const yt = Math.max(0, Math.trunc(input.yieldTotal ?? 0));
  const r = await pool.query(
    `update public.discovery_coverage_task
     set status = $2, yield_new = $3, yield_total = $4,
         note = coalesce($5, note), finished_at = now()
     where id = $1 and status = 'running'`,
    [taskId, input.status, yn, yt, input.note?.trim().slice(0, 2000) ?? null],
  );
  if ((r.rowCount ?? 0) === 0) {
    throw fail(409, "task_not_running", "only running tasks can be finished");
  }
}

/** Read the coverage ledger for a run (projection; never writes). */
export async function coverageSummary(pool: Pool, runId: string): Promise<CoverageSummary> {
  const r = await pool.query(
    `select status, count(*)::int as n,
            coalesce(sum(yield_new), 0)::int as yn,
            coalesce(sum(yield_total), 0)::int as yt
     from public.discovery_coverage_task where run_id = $1 group by status`,
    [runId],
  );
  const out: CoverageSummary = {
    total: 0, pending: 0, running: 0, done: 0, exhausted: 0,
    failed: 0, skipped_low_yield: 0, yield_new: 0, yield_total: 0,
  };
  // Explicit allowlist (not `in`): status comes from a CHECK-constrained
  // column, but the tally must never be corruptible via prototype keys.
  const buckets = new Set(["pending", "running", "done", "exhausted", "failed", "skipped_low_yield"]);
  for (const row of r.rows as { status: string; n: number; yn: number; yt: number }[]) {
    out.total += row.n;
    out.yield_new += row.yn;
    out.yield_total += row.yt;
    if (buckets.has(row.status)) (out as unknown as Record<string, number>)[row.status] += row.n;
  }
  return out;
}

export interface StopEvaluation {
  stop: boolean;
  reason:
    | "tasks_exhausted"
    | "low_yield_stop"
    | "concentration_reroute"
    | "continue";
  detail: string;
}

/**
 * Evaluate stopping rules over recent task history. Pure over caller inputs
 * plus one bounded read; thresholds come from StopConfig (explicit).
 */
export async function evaluateStops(
  pool: Pool,
  runId: string,
  cfg: StopConfig,
): Promise<StopEvaluation> {
  if (!Number.isInteger(cfg.lowYieldStreak) || cfg.lowYieldStreak < 1) {
    throw fail(422, "bad_stop_config", "lowYieldStreak must be a positive integer (no default exists)");
  }
  if (!Number.isInteger(cfg.concentrationCap) || cfg.concentrationCap < 1) {
    throw fail(422, "bad_stop_config", "concentrationCap must be a positive integer (no default exists)");
  }
  const r = await pool.query(
    `select status, yield_new, adapter_id
     from public.discovery_coverage_task
     where run_id = $1 and status in ('done', 'exhausted', 'failed', 'skipped_low_yield')
     order by finished_at desc, plan_seq desc, id desc limit 50`,
    [runId],
  );
  const rows = r.rows as { status: string; yield_new: number; adapter_id: string }[];
  const pending = await pool.query(
    "select count(*)::int as n from public.discovery_coverage_task where run_id = $1 and status in ('pending', 'running')",
    [runId],
  );
  // Precedence is the blueprint's, in order: an exhausted task list IS the end
  // of the refresh, so it is reported before mid-plan rules. The streak and
  // concentration rules can only fire while work remains - plan_seq breaks
  // finished_at ties deterministically (same-microsecond completions).
  if ((pending.rows[0].n as number) === 0 && rows.length > 0) {
    return { stop: true, reason: "tasks_exhausted", detail: "no pending or running tasks remain" };
  }
  let streak = 0;
  for (const row of rows) {
    if (row.status === "done" && row.yield_new === 0) streak++;
    else break;
  }
  if (streak >= cfg.lowYieldStreak) {
    return {
      stop: true,
      reason: "low_yield_stop",
      detail: `${streak} consecutive zero-new tasks (threshold ${cfg.lowYieldStreak})`,
    };
  }
  const perSource = new Map<string, number>();
  for (const row of rows) {
    if (row.status === "done") perSource.set(row.adapter_id, (perSource.get(row.adapter_id) ?? 0) + 1);
  }
  for (const [adapter, n] of perSource) {
    if (n >= cfg.concentrationCap) {
      return {
        stop: false,
        reason: "concentration_reroute",
        detail: `${adapter} produced ${n} consecutive tasks (cap ${cfg.concentrationCap}) — reroute remaining share`,
      };
    }
  }
  return { stop: false, reason: "continue", detail: "no stopping rule triggered" };
}

export interface ShortfallRow {
  pipeline: string;
  target: number;
  actual: number;
  shortfall: number;
  reason: string;
}

/**
 * Shortfall report builder. Targets are explicit caller inputs (no approved
 * allocation exists — O2); this function NEVER transfers between pipelines:
 * each row stands alone, shortfalls reported, never netted.
 */
export function shortfallReport(
  rows: { pipeline: string; target: number; actual: number; reason?: string }[],
): ShortfallRow[] {
  return rows.map((r) => {
    if (!Number.isInteger(r.target) || r.target < 0 || !Number.isInteger(r.actual) || r.actual < 0) {
      throw fail(422, "bad_shortfall_input", "target/actual must be non-negative integers");
    }
    return {
      pipeline: r.pipeline,
      target: r.target,
      actual: r.actual,
      shortfall: Math.max(0, r.target - r.actual),
      reason: (r.reason ?? "").trim().slice(0, 500) || "not recorded",
    };
  });
}
