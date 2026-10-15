/**
 * Discovery coverage tests (local DB only, loopback guard).
 * Covers TEST_PLAN T-DISC-I6 (partial): planning validation, claim/finish
 * lifecycle, concurrent claiming, stop-rule evaluation with explicit
 * thresholds, shortfall builder (no netting). DB-BACKED: blocked until
 * Docker/PostgreSQL is available.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimTask,
  coverageSummary,
  evaluateStops,
  finishTask,
  planRefresh,
  shortfallReport,
} from "../lib/discovery/coverage";

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 3 });

async function mkRun(queryText: string): Promise<string> {
  const c = await pool.connect();
  try {
    const r = await c.query(
      `insert into public.discovery_run (adapter_id, adapter_version, status, query_text, created_by)
       values ('gleif-lei', 'test', 'running', $1, 'ddisc') returning id`,
      [queryText],
    );
    return r.rows[0].id as string;
  } finally {
    c.release();
  }
}

async function cleanupRun(runId: string) {
  const c = await pool.connect();
  try {
    await c.query("delete from public.discovery_coverage_task where run_id = $1", [runId]);
    await c.query("delete from public.discovery_run where id = $1", [runId]);
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  const c = await pool.connect();
  try {
    await c.query("delete from public.discovery_coverage_task where query_text like 'ddisc-%'");
  } finally {
    c.release();
  }
});

afterAll(async () => {
  await pool.end();
});

describe("planRefresh + claim/finish lifecycle", () => {
  it("validates plans and tracks task states", async () => {
    const runId = await mkRun("ddisc-plan");
    try {
      await expect(planRefresh(pool, runId, [])).rejects.toMatchObject({ status: 422, code: "bad_plan" });
      await expect(planRefresh(pool, runId, [{ adapterId: "", queryText: "x" }])).rejects.toMatchObject({
        status: 422,
        code: "bad_task",
      });
      await expect(
        planRefresh(pool, "00000000-0000-4000-8000-000000000000", [{ adapterId: "a", queryText: "x" }]),
      ).rejects.toMatchObject({ status: 404 });
      const p = await planRefresh(pool, runId, [
        { adapterId: "gleif-lei", queryText: "ddisc-task-1" },
        { adapterId: "gleif-lei", queryText: "ddisc-task-2" },
      ]);
      expect(p.planned).toBe(2);
      const t1 = await claimTask(pool, runId);
      expect(t1?.queryText).toBe("ddisc-task-1");
      const t2 = await claimTask(pool, runId);
      expect(t2?.queryText).toBe("ddisc-task-2");
      expect(await claimTask(pool, runId)).toBeNull();
      await finishTask(pool, t1!.id, { status: "done", yieldNew: 3, yieldTotal: 5 });
      await finishTask(pool, t2!.id, { status: "exhausted", yieldNew: 0, yieldTotal: 1 });
      await expect(finishTask(pool, t1!.id, { status: "done" })).rejects.toMatchObject({
        status: 409,
        code: "task_not_running",
      });
      const s = await coverageSummary(pool, runId);
      expect(s).toMatchObject({
        total: 2, pending: 0, running: 0, done: 1, exhausted: 1, yield_new: 3, yield_total: 6,
      });
    } finally {
      await cleanupRun(runId);
    }
  });

  it("never double-claims under concurrency", async () => {
    const runId = await mkRun("ddisc-race");
    try {
      await planRefresh(pool, runId, [{ adapterId: "gleif-lei", queryText: "ddisc-race-task" }]);
      const results = await Promise.all(Array.from({ length: 10 }, () => claimTask(pool, runId)));
      expect(results.filter(Boolean)).toHaveLength(1);
    } finally {
      await cleanupRun(runId);
    }
  });
});

describe("evaluateStops (explicit thresholds only)", () => {
  it("reports tasks_exhausted when nothing remains", async () => {
    const runId = await mkRun("ddisc-exhaust");
    try {
      await planRefresh(pool, runId, [{ adapterId: "gleif-lei", queryText: "ddisc-ex-t" }]);
      const t = (await claimTask(pool, runId))!;
      await finishTask(pool, t.id, { status: "done", yieldNew: 1, yieldTotal: 1 });
      const e = await evaluateStops(pool, runId, { lowYieldStreak: 3, concentrationCap: 5 });
      expect(e).toMatchObject({ stop: true, reason: "tasks_exhausted" });
    } finally {
      await cleanupRun(runId);
    }
  });

  it("stops on consecutive zero-yield streaks (caller-stated N)", async () => {
    const runId = await mkRun("ddisc-streak");
    try {
      await planRefresh(pool, runId, [
        { adapterId: "gleif-lei", queryText: "ddisc-s-1" },
        { adapterId: "gleif-lei", queryText: "ddisc-s-2" },
        { adapterId: "gleif-lei", queryText: "ddisc-s-3" },
        { adapterId: "gleif-lei", queryText: "ddisc-s-4" },
      ]);
      for (let i = 0; i < 2; i++) {
        const t = (await claimTask(pool, runId))!;
        await finishTask(pool, t.id, { status: "done", yieldNew: 0, yieldTotal: 4 });
      }
      const e2 = await evaluateStops(pool, runId, { lowYieldStreak: 3, concentrationCap: 99 });
      expect(e2.stop).toBe(false);
      const t = (await claimTask(pool, runId))!;
      await finishTask(pool, t.id, { status: "done", yieldNew: 0, yieldTotal: 2 });
      // A task still remains: the mid-plan rule is what ends this refresh
      // (an exhausted list would be reported as tasks_exhausted instead).
      const e3 = await evaluateStops(pool, runId, { lowYieldStreak: 3, concentrationCap: 99 });
      expect(e3).toMatchObject({ stop: true, reason: "low_yield_stop" });
    } finally {
      await cleanupRun(runId);
    }
  });

  it("flags concentration reroutes without stopping", async () => {
    const runId = await mkRun("ddisc-conc");
    try {
      await planRefresh(pool, runId, [
        { adapterId: "gleif-lei", queryText: "ddisc-c-1" },
        { adapterId: "gleif-lei", queryText: "ddisc-c-2" },
        { adapterId: "gleif-lei", queryText: "ddisc-c-3" },
      ]);
      // Yield >0 so the streak rule stays quiet; concentration cap 2 triggers.
      for (let i = 0; i < 2; i++) {
        const t = (await claimTask(pool, runId))!;
        await finishTask(pool, t.id, { status: "done", yieldNew: 1, yieldTotal: 1 });
      }
      const e = await evaluateStops(pool, runId, { lowYieldStreak: 9, concentrationCap: 2 });
      expect(e).toMatchObject({ stop: false, reason: "concentration_reroute" });
    } finally {
      await cleanupRun(runId);
    }
  });

  it("rejects missing thresholds (no defaults exist)", async () => {
    const runId = await mkRun("ddisc-nocfg");
    try {
      await expect(evaluateStops(pool, runId, { lowYieldStreak: 0, concentrationCap: 2 })).rejects.toMatchObject({
        status: 422,
        code: "bad_stop_config",
      });
    } finally {
      await cleanupRun(runId);
    }
  });
});

describe("shortfallReport", () => {
  it("reports per-pipeline shortfalls without netting", () => {
    const rows = shortfallReport([
      { pipeline: "agency_partner", target: 25, actual: 30, reason: "ddisc: over target" },
      { pipeline: "direct_client", target: 25, actual: 3, reason: "ddisc: scope undecided" },
    ]);
    expect(rows).toEqual([
      { pipeline: "agency_partner", target: 25, actual: 30, shortfall: 0, reason: "ddisc: over target" },
      { pipeline: "direct_client", target: 25, actual: 3, shortfall: 22, reason: "ddisc: scope undecided" },
    ]);
  });

  it("rejects non-integer inputs", () => {
    expect(() => shortfallReport([{ pipeline: "x", target: -1, actual: 0 }])).toThrow(
      expect.objectContaining({ status: 422 }),
    );
  });
});
