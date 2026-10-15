/**
 * F5/F6: planning atomicity and parent-run finalization on a planning failure.
 *
 * Two related defects, one root cause — planning wrote one task per
 * auto-committed statement and the parent run row was created before it:
 *   F5  a failure on task N left a PARTIAL plan stored (the run looked planned
 *       and would execute the wrong work),
 *   F6  and the parent run stayed `running` with nothing to execute, so only
 *       the reaper could ever close it.
 *
 * Deterministic by construction: the failure is injected through a pool
 * wrapper that throws on the Nth matching INSERT. No timing, no monkey-patching
 * of the module under test, real database rows on the isolated test database.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistry } from "../lib/discovery/registry";
import { AgencyDirectoryFixture } from "../lib/discovery/fixtures/agency-directory";
import { coverageSummary, planRefresh } from "../lib/discovery/coverage";
import { runRefresh } from "../lib/discovery/refresh";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 4 });
const ACTOR = "f56";

/**
 * Fault-injecting pool: the Nth query matching `pattern` fails, everything
 * else reaches the real database. Released clients are handled by the callee's
 * own `finally`, so no connection leaks.
 */
function failingPool(base: Pool, pattern: RegExp, failOnCall: number): Pool {
  return {
    connect: async () => {
      const client = await base.connect();
      let hits = 0;
      return {
        query: (sql: string, params?: unknown[]) => {
          if (pattern.test(sql)) {
            hits += 1;
            if (hits === failOnCall) {
              return Promise.reject(new Error("simulated planning failure"));
            }
          }
          return client.query(sql, params as never[]);
        },
        release: () => client.release(),
      };
    },
    query: (sql: string, params?: unknown[]) => base.query(sql, params as never[]),
    end: () => base.end(),
  } as unknown as Pool;
}

const TASK_INSERT = /insert\s+into\s+public\.discovery_coverage_task/i;

async function newParent(): Promise<string> {
  const r = await pool.query(
    `insert into public.discovery_run (adapter_id, adapter_version, status, query_text, created_by)
     values ('f56-manual', '1', 'running', $1, $2) returning id`,
    [`f56 parent (${Date.now()})`, ACTOR],
  );
  return r.rows[0].id as string;
}

async function parentRow(runId: string): Promise<{
  status: string;
  error: string | null;
  finished_at: Date | null;
}> {
  const r = await pool.query(
    "select status, error, finished_at from public.discovery_run where id = $1",
    [runId],
  );
  return r.rows[0];
}

async function taskCount(runId: string): Promise<number> {
  const r = await pool.query(
    "select count(*)::int as n from public.discovery_coverage_task where run_id = $1",
    [runId],
  );
  return r.rows[0].n as number;
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
    await c.query("delete from public.company where domain_norm like 'fixture-%'");
  } finally {
    c.release();
  }
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("F5: a partial plan is never stored", () => {
  it("rolls back every task when one insert fails midway", async () => {
    try {
      const runId = await newParent();
      const faulty = failingPool(pool, TASK_INSERT, 2);
      await expect(
        planRefresh(faulty, runId, [
          { adapterId: "f56-adapter", queryText: "f56-a" },
          { adapterId: "f56-adapter", queryText: "f56-b" },
          { adapterId: "f56-adapter", queryText: "f56-c" },
        ]),
      ).rejects.toThrow(/simulated planning failure/);
      // The two inserts that "succeeded" before the failure are gone: the plan
      // is all-or-nothing, so the run can never execute a half plan.
      expect(await taskCount(runId)).toBe(0);
      // The caller is told, and the run row itself is untouched (finalizing a
      // parent is the caller's decision — runRefresh does it, see F6).
      expect((await parentRow(runId)).status).toBe("running");
    } finally {
      await cleanup();
    }
  });

  it("an unknown run id writes nothing and reports 404", async () => {
    try {
      await expect(
        planRefresh(pool, "11111111-2222-4333-8444-555555555555", [
          { adapterId: "f56-adapter", queryText: "f56-missing" },
        ]),
      ).rejects.toMatchObject({ status: 404, code: "run_not_found" });
    } finally {
      await cleanup();
    }
  });

  it("the normal path still stores the whole plan in order", async () => {
    try {
      const runId = await newParent();
      const res = await planRefresh(pool, runId, [
        { adapterId: "f56-adapter", queryText: "f56-1" },
        { adapterId: "f56-adapter", queryText: "f56-2" },
        { adapterId: "f56-adapter", queryText: "f56-3" },
      ]);
      expect(res.planned).toBe(3);
      expect(await taskCount(runId)).toBe(3);
      const s = await coverageSummary(pool, runId);
      expect(s.pending).toBe(3);
      expect(s.total).toBe(3);
      const order = await pool.query(
        "select query_text from public.discovery_coverage_task where run_id = $1 order by plan_seq",
        [runId],
      );
      expect(order.rows.map((r: { query_text: string }) => r.query_text)).toEqual([
        "f56-1",
        "f56-2",
        "f56-3",
      ]);
    } finally {
      await cleanup();
    }
  });
});

describe("F6: a planning failure never orphans the parent run", () => {
  it("closes the run as failed with the reason, then rethrows", async () => {
    try {
      const faulty = failingPool(pool, TASK_INSERT, 1);
      await expect(
        runRefresh(faulty, createRegistry([new AgencyDirectoryFixture()]), {
          tasks: [
            { adapterId: "f56-adapter", queryText: "f56-run-1" },
            { adapterId: "f56-adapter", queryText: "f56-run-2" },
          ],
          actor: ACTOR,
        }),
      ).rejects.toThrow(/simulated planning failure/);

      const parent = await pool.query(
        `select id, status, error, finished_at from public.discovery_run
         where created_by = $1 order by started_at desc, id desc limit 1`,
        [ACTOR],
      );
      expect(parent.rows).toHaveLength(1);
      const row = parent.rows[0];
      // Not left running: history must not claim work that never started.
      expect(row.status).toBe("failed");
      expect(row.finished_at).not.toBeNull();
      expect(row.error).toContain("plan could not be stored");
      // Nothing was planned, and nothing was executed.
      expect(await taskCount(row.id)).toBe(0);
      const children = await pool.query(
        "select count(*)::int as n from public.discovery_run where query_text like 'f56-run-%'",
      );
      expect(children.rows[0].n).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("a failure on a later task also closes the parent (no partial plan + no orphan)", async () => {
    try {
      const faulty = failingPool(pool, TASK_INSERT, 3);
      await expect(
        runRefresh(faulty, createRegistry([new AgencyDirectoryFixture()]), {
          tasks: [
            { adapterId: "f56-adapter", queryText: "f56-late-1" },
            { adapterId: "f56-adapter", queryText: "f56-late-2" },
            { adapterId: "f56-adapter", queryText: "f56-late-3" },
            { adapterId: "f56-adapter", queryText: "f56-late-4" },
          ],
          actor: ACTOR,
        }),
      ).rejects.toThrow(/simulated planning failure/);
      const parent = await pool.query(
        `select id, status, error from public.discovery_run
         where created_by = $1 order by started_at desc, id desc limit 1`,
        [ACTOR],
      );
      expect(parent.rows[0].status).toBe("failed");
      expect(parent.rows[0].error).toContain("plan could not be stored");
      expect(await taskCount(parent.rows[0].id)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("an ordinary refresh is unaffected (parent finalizes normally)", async () => {
    try {
      const r = await runRefresh(pool, createRegistry([new AgencyDirectoryFixture()]), {
        tasks: [{ adapterId: "agency-directory-fixture", queryText: "f56-ok", limit: 3, maxPages: 1 }],
        actor: ACTOR,
      });
      expect(r.status).toBe("ok");
      expect(r.finalized).toBe(true);
      expect(r.tasksDone).toBe(1);
      const row = await parentRow(r.runId);
      expect(row.status).toBe("ok");
      expect(row.error).toBeNull();
    } finally {
      await cleanup();
    }
  });
});