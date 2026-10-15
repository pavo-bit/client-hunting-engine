/**
 * F4: the reaper and an in-flight worker.
 *
 * A refresh parent can be closed by the operator-triggered reaper WHILE its
 * worker is still executing a task (process stalled, operator judged it dead).
 * These tests reproduce that race deterministically - no arbitrary sleeps, no
 * timing assumptions - and pin the four invariants that must hold whichever
 * order the two writers land in:
 *
 *   R1  the parent run never stays `running` (it always reaches a terminal
 *       state, so the reaper itself can never be needed twice),
 *   R2  a task's terminal state is never overwritten by the late worker
 *       (`finishTask` refuses; it does not rewrite a `failed` task as `done`),
 *   R3  completed results and evidence survive the race (child run, companies,
 *       opportunities, yields),
 *   R4  exactly one finalization, exactly one audit/failure row - no duplicate
 *       effects when both sides attempt to close the same run.
 *
 * Everything runs against the isolated test database.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistry } from "../lib/discovery/registry";
import { AgencyDirectoryFixture } from "../lib/discovery/fixtures/agency-directory";
import { claimTask, finishTask, planRefresh } from "../lib/discovery/coverage";
import { finalizeRefreshRun, refreshSummary, runRefresh } from "../lib/discovery/refresh";
import { reapStaleRuns } from "../lib/discovery/reap";
import type { DiscoveryOutcome, SourceAdapter } from "../lib/discovery/types";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 8 });
const ACTOR = "f4";
/** Long enough that unrelated rows from other suites are never candidates. */
const STALE_MINUTES = 60;

interface TaskRow {
  status: string;
  note: string | null;
  yield_new: number;
  child_run_id: string | null;
}
interface RunRow {
  status: string;
  error: string | null;
  finished_at: Date | null;
}

async function cleanup(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(
      `delete from public.opportunity
       where run_id in (select id from public.discovery_run where created_by = $1)`,
      [ACTOR],
    );
    await c.query("delete from public.discovery_run where created_by = $1", [ACTOR]);
    await c.query("delete from public.company where domain_norm like 'fixture-24-%'");
  } finally {
    c.release();
  }
}

/** A refresh parent row plus planned (pending) tasks - no worker running yet. */
async function newParent(tasks: string[]): Promise<string> {
  const c = await pool.connect();
  let runId = "";
  try {
    const r = await c.query(
      `insert into public.discovery_run (adapter_id, adapter_version, status, query_text, created_by)
       values ('f4-manual', '1', 'running', $1, $2) returning id`,
      [`f4 parent (${tasks.length} task(s))`, ACTOR],
    );
    runId = r.rows[0].id as string;
  } finally {
    c.release();
  }
  await planRefresh(
    pool,
    runId,
    tasks.map((q) => ({ adapterId: "f4-manual", queryText: q })),
  );
  return runId;
}

/** Make the run look abandoned (the reaper's only input is started_at). */
async function backdate(runId: string): Promise<void> {
  await pool.query(
    "update public.discovery_run set started_at = now() - interval '2 hours' where id = $1",
    [runId],
  );
}

async function taskRows(runId: string): Promise<TaskRow[]> {
  const r = await pool.query(
    `select status, note, yield_new, child_run_id from public.discovery_coverage_task
     where run_id = $1 order by plan_seq`,
    [runId],
  );
  return r.rows as TaskRow[];
}

async function runRow(runId: string): Promise<RunRow> {
  const r = await pool.query(
    "select status, error, finished_at from public.discovery_run where id = $1",
    [runId],
  );
  return r.rows[0] as RunRow;
}

/** Audit + failure rows this reaper wrote for ONE run (createCompany also audits). */
async function reapEffects(runId: string): Promise<{ audit: number; failure: number }> {
  const a = await pool.query(
    `select count(*)::int as n from public.audit_log
     where entity_type = 'discovery_run' and entity_id = $1 and reason like 'reaped:%'`,
    [runId],
  );
  const f = await pool.query(
    `select count(*)::int as n from public.failure_log
     where entity_type = 'discovery_run' and entity_id = $1 and detail like 'reaped:%'`,
    [runId],
  );
  return { audit: a.rows[0].n as number, failure: f.rows[0].n as number };
}

async function waitFor(fn: () => Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Adapter that runs the real fixture but blocks inside discover on the Nth
 * call. That gate is the in-flight window: the coverage task and the child run
 * are both `running` while the parent is still `running`, exactly as when a
 * process stalls mid-task.
 */
function gatedRegistry(
  blockOnCall: number,
  gate: Promise<void>,
  onGateEntered: () => void,
): ReturnType<typeof createRegistry> {
  const base = new AgencyDirectoryFixture();
  let calls = 0;
  const adapter: SourceAdapter = {
    manifest: () => ({ ...base.manifest(), id: "f4-slow-adapter", version: "1.0.0" }),
    validateConfig: (c) => base.validateConfig(c),
    normalize: (raw, m) => base.normalize(raw, m),
    provenance: (raw, m) => base.provenance(raw, m),
    health: (c) => base.health(c),
    discover: async (q, ctx): Promise<DiscoveryOutcome> => {
      calls += 1;
      if (calls === blockOnCall) {
        onGateEntered();
        await gate;
      }
      // Distinct seed => distinct source-record ids => no cross-suite collision.
      return base.discover(q, { ...ctx, config: { seed: 24 } });
    },
  };
  return createRegistry([adapter]);
}

/** A one-shot gate: the adapter parks on `wait`; the test observes `entered`. */
function gate() {
  let release!: () => void;
  let markEntered!: () => void;
  let entered = false;
  return {
    wait: new Promise<void>((r) => {
      release = r;
    }),
    enteredPromise: new Promise<void>((r) => {
      markEntered = () => {
        entered = true;
        r();
      };
    }),
    markEntered: () => markEntered(),
    release: () => release(),
    hasEntered: () => entered,
  };
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("F4/R1+R3+R4: the worker finishes first, the reaper runs afterwards", () => {
  it("keeps the completed task, closes the parent, and audits exactly once", async () => {
    try {
      const parent = await newParent(["f4-done-first-a", "f4-done-first-b"]);
      const task = await claimTask(pool, parent);
      expect(task).not.toBeNull();
      await finishTask(pool, task!.id, {
        status: "done",
        yieldNew: 4,
        yieldTotal: 6,
        note: "f4 completed before the reaper",
      });

      await backdate(parent);
      const reap = await reapStaleRuns(pool, { staleAfterMinutes: STALE_MINUTES, actor: ACTOR });
      expect(reap.reaped.map((r) => r.runId)).toContain(parent);
      expect(reap.reaped.find((r) => r.runId === parent)?.tasksFailed).toBe(1);

      // R3: the completed task keeps its result, note and yield - untouched.
      const rows = await taskRows(parent);
      expect(rows[0]).toMatchObject({
        status: "done",
        note: "f4 completed before the reaper",
        yield_new: 4,
      });
      // The never-started task is terminal with the reaper's reason.
      expect(rows[1].status).toBe("failed");
      expect(String(rows[1].note)).toContain("reaped:");

      // R1: the parent reached a terminal state with a reason.
      const run = await runRow(parent);
      expect(run.status).toBe("failed");
      expect(run.error).toContain("reaped:");
      expect(run.finished_at).not.toBeNull();

      // R4: one reap, one audit row, one failure row - even after another call.
      expect(await reapEffects(parent)).toEqual({ audit: 1, failure: 1 });
      const again = await reapStaleRuns(pool, { staleAfterMinutes: STALE_MINUTES, actor: ACTOR });
      expect(again.reaped.map((r) => r.runId)).not.toContain(parent);
      expect(await reapEffects(parent)).toEqual({ audit: 1, failure: 1 });
    } finally {
      await cleanup();
    }
  });
});

describe("F4/R2: the reaper closes the task first, the worker returns late", () => {
  it("refuses the late finish and does not resurrect or re-finalize the run", async () => {
    try {
      const parent = await newParent(["f4-reap-first-a", "f4-reap-first-b"]);
      const task = await claimTask(pool, parent);
      expect(task).not.toBeNull();

      await backdate(parent);
      await reapStaleRuns(pool, { staleAfterMinutes: STALE_MINUTES, actor: ACTOR });

      // R2: the late worker is told the task is no longer running - loudly, not
      // silently, and the reaper's state survives untouched.
      await expect(
        finishTask(pool, task!.id, { status: "done", yieldNew: 5, yieldTotal: 5 }),
      ).rejects.toMatchObject({ status: 409, code: "task_not_running" });

      const rows = await taskRows(parent);
      expect(rows.map((r) => r.status)).toEqual(["failed", "failed"]);
      expect(rows[0].note).toContain("reaped:");
      expect(rows[0].yield_new).toBe(0);

      // R1/R4: the worker's finalization is refused; the reaper's close stands.
      const before = await runRow(parent);
      expect(await finalizeRefreshRun(pool, parent, "ok", "late worker")).toBe(false);
      const after = await runRow(parent);
      expect(after.status).toBe("failed");
      expect(after.error).toBe(before.error);
      expect(after.finished_at?.getTime()).toBe(before.finished_at?.getTime());
      expect(await reapEffects(parent)).toEqual({ audit: 1, failure: 1 });
    } finally {
      await cleanup();
    }
  });
});

describe("F4: both attempt finalization at once", () => {
  it("converges on one coherent terminal state with a single audit effect", async () => {
    try {
      const parent = await newParent(["f4-simultaneous"]);
      const task = await claimTask(pool, parent);
      expect(task).not.toBeNull();
      await backdate(parent);

      const [worker, reaper] = await Promise.allSettled([
        finishTask(pool, task!.id, { status: "done", yieldNew: 3, yieldTotal: 3 }),
        reapStaleRuns(pool, { staleAfterMinutes: STALE_MINUTES, actor: ACTOR }),
      ]);

      // Whichever order won, the outcome is one of exactly two coherent states
      // - and never a task that "finished" while stored as failed.
      const rows = await taskRows(parent);
      const reapedCount = reaper.status === "fulfilled"
        ? (reaper.value.reaped.filter((r) => r.runId === parent).length)
        : 0;
      expect(reapedCount).toBeLessThanOrEqual(1);
      if (worker.status === "fulfilled") {
        // Worker won the row: its completion is preserved.
        expect(rows[0]).toMatchObject({ status: "done", yield_new: 3 });
      } else {
        expect(worker.reason).toMatchObject({ status: 409, code: "task_not_running" });
        expect(rows[0]).toMatchObject({ status: "failed", yield_new: 0 });
        expect(String(rows[0].note)).toContain("reaped:");
      }

      // R1: the parent is terminal either way.
      const run = await runRow(parent);
      expect(run.status).toBe("failed");
      expect(run.finished_at).not.toBeNull();
      // R4: a second finalization attempt changes nothing and audits nothing.
      expect(await finalizeRefreshRun(pool, parent, "partial", "second")).toBe(false);
      expect(await reapEffects(parent)).toEqual({ audit: 1, failure: 1 });
    } finally {
      await cleanup();
    }
  });
});

describe("F4 end-to-end: a live refresh is reaped mid-task", () => {
  it("never stays running, keeps the finished work, and reports the stored status", async () => {
    const g = gate();
    const registry = gatedRegistry(2, g.wait, g.markEntered);
    let running: Promise<Awaited<ReturnType<typeof runRefresh>>> | undefined;
    try {
      // Two tasks: the first completes normally, the second is in flight when
      // the operator decides the run is dead.
      running = runRefresh(pool, registry, {
        tasks: [
          { adapterId: "f4-slow-adapter", queryText: "f4-live-first", limit: 3, maxPages: 1 },
          { adapterId: "f4-slow-adapter", queryText: "f4-live-second", limit: 3, maxPages: 1 },
        ],
        actor: ACTOR,
      });

      await g.enteredPromise;
      // Evidence of the exact race window: task 2 running, child run running,
      // parent still running.
      const parent = await parentOf("f4-live-second");
      const inFlight = await pool.connect();
      try {
        const rows = await inFlight.query(
          `select t.status as task_status, c.status as child_status, p.status as parent_status
           from public.discovery_coverage_task t
           join public.discovery_run c on c.adapter_id = 'f4-slow-adapter' and c.status = 'running'
           join public.discovery_run p on p.id = t.run_id
           where t.run_id = $1 and t.query_text = 'f4-live-second'`,
          [parent],
        );
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0]).toMatchObject({
          task_status: "running",
          child_status: "running",
          parent_status: "running",
        });
      } finally {
        inFlight.release();
      }

      await backdate(parent);
      const reap = await reapStaleRuns(pool, { staleAfterMinutes: STALE_MINUTES, actor: ACTOR });
      expect(reap.reaped.map((r) => r.runId)).toContain(parent);

      // Let the blocked worker finish its task; it now finds a closed world.
      g.release();
      const result = await running;
      running = undefined;
      // R1: not running, finalized by the reaper - the worker finalized nothing.
      expect(result.finalized).toBe(false);
      const run = await runRow(parent);
      expect(run.status).toBe("failed");
      expect(run.error).toContain("reaped:");
      // Truthfulness: the worker completed one task and failed one, which it
      // would report as `partial` - but the stored status is what the response
      // must carry, because that is the run's actual state.
      expect(result.tasksDone).toBe(1);
      expect(result.status).toBe("failed");

      // R2: the reaped in-flight task was not rewritten as done.
      const rows = await taskRows(parent);
      expect(rows.map((r) => r.status).sort()).toEqual(["done", "failed"]);
      expect(String(rows[1].note)).toContain("reaped:");
      // Bounded and deliberate: the late worker may still attach the child run
      // pointer (provenance for the data the child committed), but that is the
      // ONLY thing it may touch on a closed task - status, reason and yields
      // remain the reaper's.
      expect(rows[1].child_run_id).not.toBeNull();
      expect(rows[1].yield_new).toBe(0);

      // R3: the completed task's results and evidence survived the race.
      expect(rows[0].child_run_id).not.toBeNull();
      const child = await pool.connect();
      try {
        const c = await child.query(
          "select status, found, created_new from public.discovery_run where id = $1",
          [rows[0].child_run_id],
        );
        expect(c.rows[0].status).toBe("ok");
        expect(c.rows[0].created_new).toBeGreaterThan(0);
        const opps = await child.query(
          "select count(*)::int as n from public.opportunity where run_id = $1",
          [parent],
        );
        expect(opps.rows[0].n).toBeGreaterThan(0);
        const companies = await child.query(
          "select count(*)::int as n from public.company where domain_norm like 'fixture-24-%'",
        );
        expect(companies.rows[0].n).toBeGreaterThan(0);
      } finally {
        child.release();
      }

      // R4: one reap effect only, and reaping again does nothing.
      expect(await reapEffects(parent)).toEqual({ audit: 1, failure: 1 });
      const again = await reapStaleRuns(pool, { staleAfterMinutes: STALE_MINUTES, actor: ACTOR });
      expect(again.reaped.map((r) => r.runId)).not.toContain(parent);

      const s = await refreshSummary(pool, parent);
      expect(s.runStatus).toBe("failed");
      expect(s.endState).toBe("failed");
      expect(s.coverage.done).toBe(1);
      expect(s.coverage.pending + s.coverage.running).toBe(0);
    } finally {
      g.release();
      // Never let the worker write after cleanup.
      await running?.catch(() => undefined);
      await cleanup();
    }
  });
});

/** Parent run of the coverage task with this query text. */
async function parentOf(queryText: string): Promise<string> {
  const r = await pool.query(
    "select run_id from public.discovery_coverage_task where query_text = $1 limit 1",
    [queryText],
  );
  return r.rows[0].run_id as string;
}

describe("F4: reaping stays manual and conservative", () => {
  it("a dry run reports candidates and writes nothing", async () => {
    try {
      const parent = await newParent(["f4-dry-run"]);
      await claimTask(pool, parent);
      await backdate(parent);
      const dry = await reapStaleRuns(pool, {
        staleAfterMinutes: STALE_MINUTES,
        actor: ACTOR,
        dryRun: true,
      });
      expect(dry.dryRun).toBe(true);
      expect(dry.considered.map((r) => r.id)).toContain(parent);
      expect(dry.reaped).toEqual([]);
      const run = await runRow(parent);
      expect(run.status).toBe("running");
      expect(run.finished_at).toBeNull();
      expect((await taskRows(parent)).every((r) => r.status === "running" || r.status === "pending")).toBe(true);
      expect(await reapEffects(parent)).toEqual({ audit: 0, failure: 0 });
    } finally {
      await cleanup();
    }
  });

  it("rejects a missing actor instead of reaping unattributed", async () => {
    await expect(
      reapStaleRuns(pool, { staleAfterMinutes: STALE_MINUTES, actor: "  " }),
    ).rejects.toMatchObject({ status: 422, code: "actor_required" });
  });
});