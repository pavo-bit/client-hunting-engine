/**
 * F1 regression: the OVERALL refresh deadline (approved contract: 120 s budget
 * for the whole refresh, separate from each child run's own timeout).
 *
 * Deterministic by construction: the clock is injected (`now`), so no test
 * sleeps or races a timer. The parent run, coverage ledger and opportunity
 * rows are all read back from PostgreSQL, and every fixture is namespaced
 * `d1-` / `fixture-` so cleanup is surgical and never touches seeded rows.
 *
 * Covered (review checklist):
 *   1. deadline expires before all planned tasks begin
 *   2. no new task is claimed after the deadline
 *   3. the parent run reaches a correct terminal state
 *   4. remaining tasks are accounted for truthfully
 *   5. completed work stays preserved (companies, opportunities, child run)
 *   6. in-flight/finished work is not corrupted by a second finalization
 *   7. a refresh that finishes inside the budget is unaffected
 *   8. repeated finalization duplicates nothing and audits nothing twice
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistry, type AdapterRegistry } from "../lib/discovery/registry";
import { AgencyDirectoryFixture } from "../lib/discovery/fixtures/agency-directory";
import {
  DEFAULT_REFRESH_BUDGET_MS,
  finalizeRefreshRun,
  refreshSummary,
  runRefresh,
} from "../lib/discovery/refresh";
import type { DiscoveryOutcome, SourceAdapter } from "../lib/discovery/types";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 3 });
const ACTOR = "d1";

function fixtureRegistry(): AdapterRegistry {
  return createRegistry([new AgencyDirectoryFixture()]);
}

/** Adapter that always fails with a typed, retryable network error.
 *  Wraps the shipped fixture so the whole adapter contract stays real. */
function failingRegistry(): AdapterRegistry {
  const base = new AgencyDirectoryFixture();
  const adapter: SourceAdapter = {
    manifest: () => ({ ...base.manifest(), id: "d1-failing-adapter", version: "1.0.0" }),
    validateConfig: (c) => base.validateConfig(c),
    normalize: (raw, m) => base.normalize(raw, m),
    provenance: (raw, m) => base.provenance(raw, m),
    health: (c) => base.health(c),
    discover: async (): Promise<DiscoveryOutcome> => ({
      kind: "failed",
      cause: "network",
      message: "d1 deterministic failure",
      retryable: true,
    }),
  };
  return createRegistry([adapter]);
}

/** Clock that advances by `stepMs` on every read; deterministic, no waiting. */
function steppingClock(stepMs: number): () => number {
  let t = 1_000;
  return () => {
    const now = t;
    t += stepMs;
    return now;
  };
}

async function cleanup(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(
      "delete from public.opportunity where opportunity_key like 'opp:agency_partner:agency-directory:%'",
    );
    await c.query("delete from public.discovery_coverage_task where query_text like 'd1-%'");
    await c.query(
      "delete from public.discovery_run where query_text like 'manual refresh:%' or created_by = $1",
      [ACTOR],
    );
    await c.query("delete from public.company where domain_norm like 'fixture-%' or domain_norm like 'd1-%'");
  } finally {
    c.release();
  }
}

async function taskRows(runId: string): Promise<
  { status: string; note: string | null; child_run_id: string | null; yield_new: number }[]
> {
  const c = await pool.connect();
  try {
    const r = await c.query(
      `select status, note, child_run_id, yield_new from public.discovery_coverage_task
       where run_id = $1 order by plan_seq`,
      [runId],
    );
    return r.rows as { status: string; note: string | null; child_run_id: string | null; yield_new: number }[];
  } finally {
    c.release();
  }
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("F1.1: the deadline expires before any planned task begins", () => {
  it("claims nothing, terminates the parent, and accounts for every task", async () => {
    try {
      const r = await runRefresh(
        pool,
        fixtureRegistry(),
        {
          tasks: [
            { adapterId: "agency-directory-fixture", queryText: "d1-a", limit: 3, maxPages: 1 },
            { adapterId: "agency-directory-fixture", queryText: "d1-b", limit: 3, maxPages: 1 },
            { adapterId: "agency-directory-fixture", queryText: "d1-c", limit: 3, maxPages: 1 },
          ],
          actor: ACTOR,
          deadlineMs: 1,
          // First read sets the base; the next read is already past the budget.
          now: steppingClock(5_000),
        },
      );
      expect(r.stoppedBy).toBe("deadline");
      expect(r.status).toBe("cancelled");
      expect(r.finalized).toBe(true);
      expect(r.tasksPlanned).toBe(3);
      expect(r.tasksDone).toBe(0);

      const rows = await taskRows(r.runId);
      expect(rows).toHaveLength(3);
      // (2) nothing was ever claimed: no child run, no yield.
      for (const row of rows) {
        expect(row.child_run_id).toBeNull();
        expect(row.yield_new).toBe(0);
        expect(row.status).toBe("failed");
        // (4) truthful reason, and NOT the low-yield status.
        expect(String(row.note)).toContain("not started: overall refresh deadline reached");
        expect(row.status).not.toBe("skipped_low_yield");
      }

      // (3) parent is terminal with a reason.
      const c = await pool.connect();
      try {
        const run = await c.query(
          "select status, finished_at, error from public.discovery_run where id = $1",
          [r.runId],
        );
        expect(run.rows[0].status).toBe("cancelled");
        expect(run.rows[0].finished_at).not.toBeNull();
        expect(run.rows[0].error).toContain("deadline");
        // No child run rows were created at all.
        const children = await c.query(
          "select count(*)::int as n from public.discovery_run where query_text like 'd1-%'",
        );
        expect(children.rows[0].n).toBe(0);
      } finally {
        c.release();
      }

      const s = await refreshSummary(pool, r.runId);
      expect(s.endState).toBe("time_stop");
      expect(s.coverage.total).toBe(3);
      expect(s.coverage.done).toBe(0);
      expect(s.coverage.pending + s.coverage.running).toBe(0);
      expect(s.coverage.failed).toBe(3);
    } finally {
      await cleanup();
    }
  });
});

describe("F1.2–F1.5: the deadline stops new claims and preserves completed work", () => {
  it("runs one task, then stops - completed rows untouched", async () => {
    try {
      const r = await runRefresh(
        pool,
        fixtureRegistry(),
        {
          tasks: [
            { adapterId: "agency-directory-fixture", queryText: "d1-one", limit: 4, maxPages: 1 },
            { adapterId: "agency-directory-fixture", queryText: "d1-two", limit: 4, maxPages: 1 },
            { adapterId: "agency-directory-fixture", queryText: "d1-three", limit: 4, maxPages: 1 },
          ],
          actor: ACTOR,
          deadlineMs: 60_000,
          // Reads: base, loop#1 (before task 1), loop#2 (after task 1 - past it).
          now: steppingClock(40_000),
        },
      );
      expect(r.stoppedBy).toBe("deadline");
      expect(r.tasksDone).toBe(1);

      const rows = await taskRows(r.runId);
      expect(rows).toHaveLength(3);
      // FIFO: the completed task is the first planned one.
      expect(rows[0].status).toBe("done");
      expect(rows[0].child_run_id).not.toBeNull();
      expect(rows[0].yield_new).toBeGreaterThan(0);
      for (const row of rows.slice(1)) {
        expect(row.status).toBe("failed");
        expect(row.child_run_id).toBeNull();
        expect(String(row.note)).toContain("not started:");
      }

      // (5) completed work preserved: its companies and opportunities survive.
      const c = await pool.connect();
      try {
        const opps = await c.query(
          "select count(*)::int as n from public.opportunity where run_id = $1",
          [r.runId],
        );
        expect(opps.rows[0].n).toBe(rows[0].yield_new);
        const child = await c.query(
          "select status, found, created_new from public.discovery_run where id = $1",
          [rows[0].child_run_id],
        );
        expect(child.rows.length).toBe(1);
        expect(child.rows[0].status).not.toBe("running");
        expect(child.rows[0].created_new).toBe(rows[0].yield_new);
      } finally {
        c.release();
      }

      const s = await refreshSummary(pool, r.runId);
      expect(s.endState).toBe("time_stop");
      expect(s.coverage.done).toBe(1);
      expect(s.coverage.failed).toBe(2);
      expect(s.coverage.pending + s.coverage.running).toBe(0);
      // Evidence counting is asserted honestly: `run.ts` attaches a claim only
      // when the normalized record carries a registry id (run.ts, GLEIF registry
      // fields), and these fixture records have none - so a snapshot is stored
      // but no claim, and new_evidence is legitimately 0 here. The
      // evidence-on-refresh path is covered by tests/gleif.test.ts and the E2E
      // "new evidence preserves historical observations" case.
      expect(s.measures.new_evidence).toBe(0);
      expect(s.measures.unresolved).toBeGreaterThanOrEqual(rows[0].yield_new);
    } finally {
      await cleanup();
    }
  });
});

describe("F1.6/F1.8: finalization is safe under retries and concurrent status changes", () => {
  it("a second finalization neither corrupts nor duplicates anything", async () => {
    try {
      const r = await runRefresh(
        pool,
        fixtureRegistry(),
        {
          tasks: [{ adapterId: "agency-directory-fixture", queryText: "d1-idem", limit: 3, maxPages: 1 }],
          actor: ACTOR,
          deadlineMs: 1,
          now: steppingClock(5_000),
        },
      );
      const c = await pool.connect();
      try {
        const before = await c.query(
          "select status, finished_at, error from public.discovery_run where id = $1",
          [r.runId],
        );
        const tasksBefore = await c.query(
          "select count(*)::int as n from public.discovery_coverage_task where run_id = $1",
          [r.runId],
        );

        // Someone else already finalized (reaper, earlier request): ours is a no-op.
        expect(await finalizeRefreshRun(pool, r.runId, "ok", null)).toBe(false);
        expect(await finalizeRefreshRun(pool, r.runId, "failed", "retry")).toBe(false);

        const after = await c.query(
          "select status, finished_at, error from public.discovery_run where id = $1",
          [r.runId],
        );
        const tasksAfter = await c.query(
          "select count(*)::int as n from public.discovery_coverage_task where run_id = $1",
          [r.runId],
        );
        expect(after.rows[0].status).toBe(before.rows[0].status);
        expect(after.rows[0].error).toBe(before.rows[0].error);
        expect(new Date(after.rows[0].finished_at).getTime()).toBe(
          new Date(before.rows[0].finished_at).getTime(),
        );
        expect(tasksAfter.rows[0].n).toBe(tasksBefore.rows[0].n);
      } finally {
        c.release();
      }
    } finally {
      await cleanup();
    }
  });

  it("finalizing an already-terminal run written by another writer is refused", async () => {
    try {
      const c = await pool.connect();
      let runId = "";
      try {
        const r = await c.query(
          `insert into public.discovery_run (adapter_id, adapter_version, status, query_text, created_by, finished_at)
           values ('d1-manual', '1', 'ok', 'd1-terminal', $1, now()) returning id`,
          [ACTOR],
        );
        runId = r.rows[0].id as string;
      } finally {
        c.release();
      }
      expect(await finalizeRefreshRun(pool, runId, "cancelled", "should not apply")).toBe(false);
      const c2 = await pool.connect();
      try {
        const after = await c2.query("select status, error from public.discovery_run where id = $1", [
          runId,
        ]);
        expect(after.rows[0].status).toBe("ok");
        expect(after.rows[0].error).toBeNull();
      } finally {
        c2.release();
      }
    } finally {
      await cleanup();
    }
  });
});

describe("F1.7: a refresh that finishes inside the budget is unaffected", () => {
  it("runs every planned task and reports normal completion", async () => {
    try {
      const r = await runRefresh(
        pool,
        fixtureRegistry(),
        {
          tasks: [
            { adapterId: "agency-directory-fixture", queryText: "d1-ok1", limit: 3, maxPages: 1 },
            { adapterId: "agency-directory-fixture", queryText: "d1-ok2", limit: 3, maxPages: 1 },
          ],
          actor: ACTOR,
          // Generous budget and a clock that never advances: the deadline cannot
          // fire, so this exercises the ordinary path deterministically.
          deadlineMs: DEFAULT_REFRESH_BUDGET_MS,
          now: () => 1_000,
        },
      );
      expect(r.stoppedBy).toBe("completed");
      expect(r.status).toBe("ok");
      expect(r.tasksDone).toBe(2);
      expect(r.finalized).toBe(true);
      const rows = await taskRows(r.runId);
      expect(rows.every((x) => x.status === "done")).toBe(true);
      const s = await refreshSummary(pool, r.runId);
      expect(s.endState).toBe("exhausted");
      expect(s.coverage.done).toBe(2);
      expect(s.coverage.failed).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("rejects a nonsensical budget instead of silently defaulting", async () => {
    await expect(
      runRefresh(pool, fixtureRegistry(), {
        tasks: [{ adapterId: "agency-directory-fixture", queryText: "d1-bad" }],
        actor: ACTOR,
        deadlineMs: 0,
      }),
    ).rejects.toMatchObject({ status: 422, code: "bad_deadline" });
  });
});

describe("F1 (adjacent): a failed child run is not recorded as a completed task", () => {
  it("maps the child's outcome onto the task ledger honestly", async () => {
    try {
      const r = await runRefresh(pool, failingRegistry(), {
        tasks: [{ adapterId: "d1-failing-adapter", queryText: "d1-fail", limit: 3, maxPages: 1 }],
        actor: ACTOR,
        deadlineMs: DEFAULT_REFRESH_BUDGET_MS,
        now: () => 1_000,
      });
      // runDiscovery finalizes the child as 'failed'; the task must say so too.
      expect(r.status).toBe("failed");
      expect(r.tasksDone).toBe(0);
      const rows = await taskRows(r.runId);
      expect(rows[0].status).toBe("failed");
      expect(rows[0].child_run_id).not.toBeNull();
      const s = await refreshSummary(pool, r.runId);
      expect(s.coverage.done).toBe(0);
      expect(s.coverage.failed).toBe(1);
    } finally {
      await cleanup();
    }
  });
});