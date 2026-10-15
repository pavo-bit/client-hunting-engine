// Manual planned refreshes (Prompt 5, blueprint §2). Composes frozen pieces:
// planRefresh/claimTask/finishTask (coverage), runDiscovery (single-query
// runs, untouched), registerOpportunity (idempotent). No schedulers, no
// autonomy: every refresh is an explicit operator call. Summaries are
// COMPUTED live from stored rows (frozen run counters + current opportunity
// states — the distinction is documented, not hidden).

import type { Pool } from "pg";
import type { AdapterRegistry } from "./registry";
import { runDiscovery, type RunItemResult } from "./run";
import { coverageSummary, evaluateStops, finishTask, claimTask, planRefresh, shortfallReport } from "./coverage";
import { registerOpportunity } from "./opportunities";

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

export interface RefreshTaskInput {
  adapterId: string;
  queryText: string;
  limit?: number;
  maxPages?: number;
}

export interface RefreshStopInput {
  lowYieldStreak: number;
  concentrationCap: number;
}

/**
 * Overall wall-clock budget for ONE refresh, as specified in the approved API
 * contract (docs/GRAYSCALES_DISCOVERY_API_CONTRACTS.md: "executes sequentially
 * in request scope ... 120 s overall budget"). This is separate from each
 * child run's own timeout, which still applies per task and is NOT weakened
 * here.
 */
export const DEFAULT_REFRESH_BUDGET_MS = 120_000;

export interface RefreshResult {
  runId: string;
  status: string;
  tasksPlanned: number;
  tasksDone: number;
  /** Why the loop stopped, for the operator and for tests. */
  stoppedBy: "completed" | "thresholds" | "deadline";
  /** True when this call finalized the run (false if already terminal). */
  finalized: boolean;
  /**
   * New items that were found but NOT registered as opportunities because their
   * stored discovery record had no resolvable source key (F13). Zero in every
   * normal run; non-zero means provenance could not be established and nothing
   * was invented to paper over it.
   */
  unattributedSourceRecords: number;
}

export interface RefreshOptions {
  tasks: RefreshTaskInput[];
  stop?: RefreshStopInput;
  actor: string;
  /** Override the overall budget (tests); must be a positive integer. */
  deadlineMs?: number;
  /** Injected clock for deterministic deadline tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Finalize the parent run exactly once. The `status = 'running'` predicate is
 * what makes this safe under retries and concurrent status changes: a second
 * caller (or a late retry) updates zero rows and cannot overwrite a terminal
 * state, duplicate `finished_at`, or resurrect a reaped run.
 */
export async function finalizeRefreshRun(
  pool: Pool,
  runId: string,
  status: "ok" | "partial" | "failed" | "cancelled",
  error: string | null,
): Promise<boolean> {
  const r = await pool.query(
    `update public.discovery_run
     set status = $2, finished_at = now(), error = left($3, 2000)
     where id = $1 and status = 'running'
     returning id`,
    [runId, status, error],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Status actually stored on a run row (null when the row is gone).
 *
 * A refused finalization means somebody else closed the run first - typically
 * the reaper closing a parent whose worker was still executing (F4). Reporting
 * the locally computed outcome in that case would state a status the database
 * contradicts, so the stored value wins.
 */
export async function readRunStatus(pool: Pool, runId: string): Promise<string | null> {
  const r = await pool.query("select status from public.discovery_run where id = $1", [runId]);
  return (r.rows[0]?.status as string | undefined) ?? null;
}

/** Outcome of attributing one discovery run item to an opportunity row. */
export type ItemAttribution = "registered" | "skipped" | "unattributed";

/**
 * Register ONE new discovery item as an agency_partner opportunity, using the
 * source key recorded on the stored discovery record (F13).
 *
 * F13 root cause: a missing `discovery_record` row used to fall back to the
 * literal string "unknown-source". The source key is part of the OPPORTUNITY
 * KEY (`opp:agency_partner:<source>:<record id>`), which is the row's unique,
 * permanent identity — so a placeholder key is not cosmetic, it is a
 * fabricated provenance claim that cannot be corrected later without a
 * migration, and it would silently merge records from unrelated sources that
 * happen to share a source-record id.
 *
 * Fail-closed instead: the item is reported as `unattributed`, nothing is
 * written, and the caller surfaces the count in the refresh result and in the
 * task note. The company, its evidence and the run item all remain stored and
 * inspectable - nothing is lost, only the opportunity key is withheld.
 */
export async function attributeNewItem(
  pool: Pool,
  item: RunItemResult,
  parentRunId: string,
  actor: string,
): Promise<ItemAttribution> {
  if (item.status !== "new" || !item.companyId || !item.sourceRecordId) return "skipped";
  const s = await pool.query(
    `select source_key from public.discovery_record
     where company_id = $1 and source_record_id = $2 limit 1`,
    [item.companyId, item.sourceRecordId],
  );
  const sourceKey = s.rows[0]?.source_key;
  if (typeof sourceKey !== "string" || sourceKey.trim() === "") return "unattributed";
  await registerOpportunity(pool, {
    pipeline: "agency_partner",
    sourceKey,
    sourceRecordId: item.sourceRecordId,
    companyId: item.companyId,
    runId: parentRunId,
    actor,
  });
  return "registered";
}

/**
 * Execute a manual refresh synchronously in request scope (existing
 * single-operator pattern). One parent run row + planned tasks; each task
 * runs through runDiscovery (child run rows stay in history — transparent),
 * yields feed the task ledger, and new companies become agency_partner
 * opportunities linked to the parent run.
 *
 * Stops early on either the caller-stated thresholds or the OVERALL deadline
 * (the budget above). On a deadline stop the refresh is cancelled rather than
 * failed: no task is claimed afterwards, tasks that never started are recorded
 * as terminal-but-unsuccessful with an explicit reason (they are NOT
 * `skipped_low_yield`, which means "a low-yield rule stopped this"), and the
 * parent run always reaches a terminal state.
 *
 * Known limitation (documented, bounded): a task already executing when the
 * deadline expires is NOT aborted. It finishes within its own existing run
 * timeout, so the overshoot past the deadline is at most one task's remaining
 * budget. Aborting mid-task would leave a child run half-written while its
 * already-committed records persisted, which misrepresents more than it fixes.
 */
export async function runRefresh(
  pool: Pool,
  registry: AdapterRegistry,
  input: RefreshOptions,
): Promise<RefreshResult> {
  if (!(input.actor ?? "").trim()) {
    throw fail(422, "actor_required", "acting operator identity is required for attribution");
  }
  if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > 25) {
    throw fail(422, "bad_plan", "refresh needs 1..25 coverage tasks");
  }
  const budgetMs = input.deadlineMs ?? DEFAULT_REFRESH_BUDGET_MS;
  if (!Number.isInteger(budgetMs) || budgetMs < 1) {
    throw fail(422, "bad_deadline", "deadlineMs must be a positive integer");
  }
  const clock = input.now ?? Date.now;
  const deadline = clock() + budgetMs;
  if (input.stop !== undefined) {
    if (!Number.isInteger(input.stop.lowYieldStreak) || input.stop.lowYieldStreak < 1) {
      throw fail(422, "bad_stop_config", "lowYieldStreak must be a positive integer (no default exists)");
    }
    if (!Number.isInteger(input.stop.concentrationCap) || input.stop.concentrationCap < 1) {
      throw fail(422, "bad_stop_config", "concentrationCap must be a positive integer (no default exists)");
    }
  }
  const client = await pool.connect();
  let parentId = "";
  try {
    const r = await client.query(
      `insert into public.discovery_run (adapter_id, adapter_version, status, query_text, created_by)
       values ('refresh-plan', '1', 'running', $1, $2) returning id`,
      [`manual refresh: ${input.tasks.length} task(s)`, input.actor.trim().slice(0, 200)],
    );
    parentId = r.rows[0].id as string;
  } finally {
    client.release();
  }
  // Planning failure must not orphan the parent (F6). The run row already
  // exists at this point; if the plan cannot be stored, leaving it `running`
  // would report work that never started and would only be cleaned up by the
  // reaper minutes later. Close it here, with the reason, then re-throw the
  // original error so the caller still sees what actually failed.
  let planned: { runId: string; planned: number };
  try {
    planned = await planRefresh(
      pool,
      parentId,
      input.tasks.map((t) => ({ adapterId: t.adapterId, queryText: t.queryText })),
    );
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    const detail =
      (err.code ? `[${err.code}] ` : "") +
      (e instanceof Error ? e.message : typeof e === "string" ? e : "planning failed");
    // Best-effort close: if the database itself is what failed, this write may
    // fail too. The ORIGINAL error must still reach the caller - masking it
    // with a secondary failure would hide the real cause.
    try {
      await finalizeRefreshRun(
        pool,
        parentId,
        "failed",
        `plan could not be stored: ${detail}`.slice(0, 2000),
      );
    } catch {
      /* the run stays `running`; the reaper is the documented fallback */
    }
    throw e;
  }
  let done = 0;
  let failed = 0;
  /** Items whose source provenance could not be resolved (F13): reported, never mislabeled. */
  let unattributed = 0;
  let stoppedBy: RefreshResult["stoppedBy"] = "completed";
  for (;;) {
    if (input.stop) {
      const ev = await evaluateStops(pool, parentId, {
        lowYieldStreak: input.stop.lowYieldStreak,
        concentrationCap: input.stop.concentrationCap,
      });
      if (ev.stop) {
        // Mark leftovers so the ledger shows WHY they never ran.
        const c = await pool.connect();
        try {
          await c.query(
            `update public.discovery_coverage_task set status = 'skipped_low_yield',
                    finished_at = now(), note = $2
             where run_id = $1 and status = 'pending'`,
            [parentId, `stopped: ${ev.reason} — ${ev.detail}`.slice(0, 2000)],
          );
        } finally {
          c.release();
        }
        stoppedBy = "thresholds";
        break;
      }
    }
    // Overall budget: checked BEFORE every claim, so the refresh can never
    // start new work past the deadline. A task already executing is allowed to
    // finish (bounded by its own run timeout) — see the note on runRefresh.
    if (clock() >= deadline) {
      stoppedBy = "deadline";
      break;
    }
    const task = await claimTask(pool, parentId);
    if (!task) break;
    const spec = input.tasks.find(
      (t) => t.adapterId === task.adapterId && t.queryText === task.queryText,
    );
    try {
      const child = await runDiscovery(pool, registry, {
        adapterId: task.adapterId,
        queryText: task.queryText,
        limit: spec?.limit ?? 10,
        maxPages: spec?.maxPages ?? 3,
        actor: input.actor.trim().slice(0, 200),
      });
      // Link the child run for refresh-level reads (duplicate items,
      // per-task provenance) — plain update, no string parsing anywhere.
      const lc = await pool.connect();
      try {
        await lc.query("update public.discovery_coverage_task set child_run_id = $2 where id = $1", [
          task.id,
          child.runId,
        ]);
      } finally {
        lc.release();
      }
      // Register every new company as an agency_partner opportunity linked
      // to THIS refresh. The source key is read from the stored discovery
      // record - never assumed from the adapter (F13: a record whose source
      // cannot be resolved is REPORTED and skipped, never registered under a
      // placeholder key; see attributeNewItem).
      let taskUnattributed = 0;
      for (const item of child.items) {
        const attribution = await attributeNewItem(
          pool,
          item,
          parentId,
          input.actor.trim().slice(0, 200),
        );
        if (attribution === "unattributed") {
          taskUnattributed += 1;
          unattributed += 1;
        }
      }
      // Task outcome mirrors the CHILD RUN outcome. A child that failed is not
      // recorded as a completed task: "done" here would report work as
      // finished when the run itself says otherwise (surfaced by the deadline
      // stop below, and by any adapter failure).
      const childFailed = child.status === "failed";
      await finishTask(pool, task.id, {
        status: childFailed ? "failed" : "done",
        yieldNew: child.counts.new,
        yieldTotal: child.counts.found,
        // The unattributed count is written into the durable ledger, not only
        // into the HTTP response: an operator reading run history months later
        // must be able to see that N records were found but deliberately not
        // turned into opportunities (F13).
        note:
          `child run ${child.runId}: ${child.status}${child.error ? ` — ${child.error}` : ""}` +
          (taskUnattributed > 0
            ? ` — ${taskUnattributed} new item(s) skipped: source provenance unresolvable (not registered)`
            : ""),
      });
      if (childFailed) failed++;
      else done++;
    } catch (e: unknown) {
      failed++;
      // Keep the machine-readable code in history: "message alone" loses the
      // classification (e.g. source_disabled) an operator needs to act.
      const err = e as { code?: string; message?: string };
      const detail =
        (err.code ? `[${err.code}] ` : "") +
        (e instanceof Error ? e.message : typeof e === "string" ? e : "task failed");
      try {
        await finishTask(pool, task.id, {
          status: "failed",
          note: detail.slice(0, 2000),
        });
      } catch {
        // The task may already have been finalized elsewhere (for example
        // reaped while this worker was still on it). Never let that abort the
        // parent run's finalization.
      }
    }
  }
  // Deadline stop: tasks that never started are recorded as terminal but
  // explicitly unsuccessful. `skipped_low_yield` is NOT used - that status
  // means "a stopping rule stopped this refresh", which a timeout is not.
  if (stoppedBy === "deadline") {
    const reason = `overall refresh deadline reached (budget ${budgetMs} ms) - ${done} task(s) completed, ${failed} failed, remaining tasks not started`;
    const c = await pool.connect();
    try {
      await c.query(
        `update public.discovery_coverage_task
         set status = 'failed', finished_at = now(), note = left($2, 2000)
         where run_id = $1 and status = 'pending'`,
        [parentId, `not started: ${reason}`],
      );
    } finally {
      c.release();
    }
    const finalized = await finalizeRefreshRun(pool, parentId, "cancelled", reason);
    return {
      runId: parentId,
      status: finalized ? "cancelled" : ((await readRunStatus(pool, parentId)) ?? "cancelled"),
      tasksPlanned: planned.planned,
      tasksDone: done,
      stoppedBy,
      finalized,
      unattributedSourceRecords: unattributed,
    };
  }
  const status = failed > 0 && done === 0 ? "failed" : failed > 0 ? "partial" : "ok";
  const finalized = await finalizeRefreshRun(pool, parentId, status, null);
  // `finalized === false`: the run was already terminal (reaper, earlier
  // request). The stored status is the truth; the local computation describes a
  // run nobody is going to write.
  return {
    runId: parentId,
    status: finalized ? status : ((await readRunStatus(pool, parentId)) ?? status),
    tasksPlanned: planned.planned,
    tasksDone: done,
    stoppedBy,
    finalized,
    unattributedSourceRecords: unattributed,
  };
}

export interface RefreshMeasures {
  new_eligible: number;
  promoted: number;
  new_evidence: number;
  duplicates: number;
  excluded: number;
  stale: number;
  /**
   * Sum of the two counters below - kept for contract compatibility.
   * F7: this number used to mix two unrelated things (reviewable business
   * records + unfinished plan work). The split is now explicit so no consumer
   * has to guess; `unresolved` itself is unchanged.
   */
  unresolved: number;
  /** F7: opportunities currently awaiting a human decision (status `observed`). */
  unresolved_opportunities: number;
  /** F7: coverage tasks not yet in a terminal state (pending/running). */
  unresolved_tasks: number;
  /**
   * F8: every value in this object is a LIVE PROJECTION computed at read time
   * from current opportunity states, EXCEPT `duplicates` and `new_evidence`,
   * which are derived from immutable stored rows. It is NOT a frozen record of
   * what this run found at the moment it finished: promoting an opportunity
   * today moves it out of `new_eligible` for this historical run too. The only
   * frozen per-run figures are in `coverage` (the task ledger).
   */
  measures_basis: "live_projection";
}

export interface RefreshSummary {
  runId: string;
  runStatus: string;
  endState: string;
  coverage: Awaited<ReturnType<typeof coverageSummary>>;
  measures: RefreshMeasures;
  shortfall: ReturnType<typeof shortfallReport>;
}

/**
 * Live summary of a refresh: frozen task ledger + current opportunity
 * states. Frozen vs live distinction: task yields and child counters are
 * history; opportunity statuses reflect NOW (re-evaluation moves rows
 * between buckets — by design, and documented on the page).
 */
export async function refreshSummary(
  pool: Pool,
  runId: string,
  targets?: { agency_partner?: number; direct_client?: number },
): Promise<RefreshSummary> {
  const coverage = await coverageSummary(pool, runId);
  const c = await pool.connect();
  try {
    const run = await c.query("select id, status from public.discovery_run where id = $1", [runId]);
    if (run.rows.length === 0) throw fail(404, "run_not_found", "discovery run not found");
    const m = await c.query(
      `select status, count(*)::int as n from public.opportunity
       where run_id = $1 group by status`,
      [runId],
    );
    const byStatus = new Map((m.rows as { status: string; n: number }[]).map((r) => [r.status, r.n]));
    // Eligibility is a separate versioned decision (O10-gated content);
    // "eligible" here means lifecycle status, and new_eligible counts rows
    // that reached it — the explanation chain lives on the detail page.
    const unresolvedOpportunities = byStatus.get("observed") ?? 0;
    const unresolvedTasks = coverage.pending + coverage.running;
    const measures: RefreshMeasures = {
      new_eligible: byStatus.get("eligible") ?? 0,
      promoted: byStatus.get("promoted") ?? 0,
      new_evidence: 0,
      duplicates: 0,
      excluded: byStatus.get("ineligible") ?? 0,
      stale: byStatus.get("stale") ?? 0,
      // F7: the split is additive and explicit; `unresolved` remains the sum so
      // existing consumers and the published contract keep working.
      unresolved: unresolvedOpportunities + unresolvedTasks,
      unresolved_opportunities: unresolvedOpportunities,
      unresolved_tasks: unresolvedTasks,
      measures_basis: "live_projection",
    };
    // Evidence updates during the run window for this refresh's companies.
    const ev = await c.query(
      `select count(distinct cl.id)::int as n
       from public.claim cl
       join public.company co on co.id = cl.company_id
       join public.opportunity o on o.company_id = co.id
       join public.discovery_run r on r.id = $1
       where o.run_id = $1 and cl.created_at between r.started_at and coalesce(r.finished_at, now())`,
      [runId],
    );
    measures.new_evidence = ev.rows[0].n as number;
    // Duplicate observations: duplicate run items across this refresh's
    // child runs (linked via child_run_id — no string parsing).
    const dup = await c.query(
      `select count(*)::int as n from public.discovery_run_item i
       where i.status = 'duplicate'
         and i.run_id in (
           select t.child_run_id from public.discovery_coverage_task t
           where t.run_id = $1 and t.child_run_id is not null
         )`,
      [runId],
    );
    measures.duplicates = dup.rows[0].n as number;
    // End-state precedence (documented): a cancelled parent means the OVERALL
    // budget stopped the refresh -> `time_stop`, a terminal name from the
    // approved blueprint's end-state list. No other code path sets
    // `cancelled` on a refresh parent today, so this cannot mislabel.
    const endState =
      run.rows[0].status === "cancelled"
        ? "time_stop"
        : run.rows[0].status === "failed"
          ? "failed"
          : coverage.skipped_low_yield > 0
            ? "low_yield_stop"
            : coverage.failed > 0
              ? "partial"
              : coverage.pending + coverage.running > 0
                ? "incomplete_coverage"
                : "exhausted";
    const shortfall =
      targets === undefined
        ? []
        : shortfallReport([
            {
              pipeline: "agency_partner",
              target: targets.agency_partner ?? 0,
              actual: measures.new_eligible,
              reason: "caller-stated target; no approved allocation (O2)",
            },
          ]);
    return { runId, runStatus: run.rows[0].status as string, endState, coverage, measures, shortfall };
  } finally {
    c.release();
  }
}
