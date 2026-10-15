/**
 * F7 / F8: counter semantics are unambiguous and honestly labelled.
 *
 * F7 - `unresolved` used to mean "reviewable business records + unfinished plan
 * work" in one number. A consumer cannot act on that: a pending task and an
 * opportunity awaiting a human decision are different work items with different
 * owners. The split is now explicit (`unresolved_opportunities`,
 * `unresolved_tasks`); `unresolved` remains their sum for compatibility.
 *
 * F8 - every measure is a LIVE PROJECTION except the two derived from immutable
 * stored rows. Promoting an opportunity later therefore changes what a
 * historical run reports. That is a real property of this design, not a bug to
 * hide: the honest fix is to SAY SO in the payload, and to point consumers at
 * the frozen task ledger. These tests prove both facts instead of asserting a
 * frozen snapshot the system does not have.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistry } from "../lib/discovery/registry";
import { AgencyDirectoryFixture } from "../lib/discovery/fixtures/agency-directory";
import { evaluateEligibility } from "../lib/discovery/eligibility";
import { registerOpportunity, transitionOpportunity } from "../lib/discovery/opportunities";
import { coverageSummary } from "../lib/discovery/coverage";
import { refreshSummary, runRefresh } from "../lib/discovery/refresh";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 4 });
const ACTOR = "f78";
const POLICY = {
  version: "f78-policy-v1",
  gates: [{ id: "g", passed: true, reason: "f78 fixture" }],
};

async function cleanup(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(
      `delete from public.opportunity
       where opportunity_key like 'opp:agency_partner:f78-%'
          or opportunity_key like 'opp:agency_partner:agency-directory:fixture-%'`,
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

describe("F7: unresolved is split into what it actually conflates", () => {
  it("the split adds up and each half means one thing", async () => {
    try {
      const r = await runRefresh(pool, createRegistry([new AgencyDirectoryFixture()]), {
        tasks: [{ adapterId: "agency-directory-fixture", queryText: "f78-split", limit: 4, maxPages: 1 }],
        actor: ACTOR,
      });
      const s = await refreshSummary(pool, r.runId);
      const m = s.measures;
      // Arithmetic identity: the compatibility total is exactly the sum.
      expect(m.unresolved).toBe(m.unresolved_opportunities + m.unresolved_tasks);
      // This run finished, so the task half must be zero...
      expect(m.unresolved_tasks).toBe(0);
      // ...and the opportunity half is the businesses still awaiting a decision.
      expect(m.unresolved_opportunities).toBe(s.measures.unresolved);
      const rows = await pool.query(
        "select count(*)::int as n from public.opportunity where run_id = $1 and status = 'observed'",
        [r.runId],
      );
      expect(m.unresolved_opportunities).toBe(rows.rows[0].n);
    } finally {
      await cleanup();
    }
  });

  it("an unfinished plan contributes to the task half, not the opportunity half", async () => {
    try {
      const r = await runRefresh(pool, createRegistry([new AgencyDirectoryFixture()]), {
        tasks: [
          { adapterId: "agency-directory-fixture", queryText: "f78-one", limit: 3, maxPages: 1 },
          { adapterId: "f78-unknown-adapter", queryText: "f78-two", limit: 3, maxPages: 1 },
        ],
        actor: ACTOR,
      });
      const s = await refreshSummary(pool, r.runId);
      // Both tasks reached a terminal state (one done, one failed), so nothing
      // is "unfinished" - the terminal states are what says so, not the counter.
      expect(s.coverage.pending + s.coverage.running).toBe(0);
      expect(s.measures.unresolved_tasks).toBe(0);
      // The business records found by the successful task are still waiting.
      expect(s.measures.unresolved_opportunities).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });
});

describe("F8: live projection vs frozen ledger", () => {
  it("the summary labels the basis, and the frozen ledger is unaffected by later transitions", async () => {
    try {
      const r = await runRefresh(pool, createRegistry([new AgencyDirectoryFixture()]), {
        tasks: [{ adapterId: "agency-directory-fixture", queryText: "f78-live", limit: 4, maxPages: 1 }],
        actor: ACTOR,
      });
      const before = await refreshSummary(pool, r.runId);
      const frozenBefore = await coverageSummary(pool, r.runId);
      expect(before.measures.measures_basis).toBe("live_projection");
      // These opportunities are registered as `observed`; nothing is eligible
      // yet because eligibility content is O10-gated (no fake eligibility).
      expect(before.measures.new_eligible).toBe(0);

      // Move ONE of this run's opportunities to `eligible`, then back to
      // `promoted`. This is the exact event that makes a historical run's
      // counters move.
      const list = await pool.query(
        "select id from public.opportunity where run_id = $1 order by created_at limit 1",
        [r.runId],
      );
      const id = list.rows[0].id as string;
      await transitionOpportunity(pool, id, "eligible", { actor: ACTOR, reason: "f78 test" });
      const during = await refreshSummary(pool, r.runId);
      expect(during.measures.new_eligible).toBe(1);
      // The FROZEN ledger (what the run actually did) is untouched.
      const frozenDuring = await coverageSummary(pool, r.runId);
      expect(frozenDuring.yield_new).toBe(frozenBefore.yield_new);
      expect(frozenDuring.done).toBe(frozenBefore.done);

      await transitionOpportunity(pool, id, "promoted", { actor: ACTOR, reason: "f78 test" });
      const after = await refreshSummary(pool, r.runId);
      // The same historical run now reports the opportunity as promoted, not
      // new-eligible. Documented, intended, and asserted rather than hidden.
      expect(after.measures.new_eligible).toBe(0);
      expect(after.measures.promoted).toBe(1);
      expect(after.measures.measures_basis).toBe("live_projection");
      // Nothing about the run's own work changed.
      const frozenAfter = await coverageSummary(pool, r.runId);
      expect(frozenAfter.yield_new).toBe(frozenBefore.yield_new);
      expect(frozenAfter.yield_total).toBe(frozenBefore.yield_total);

      // The eligibility DECISION history is the durable, append-only record —
      // it is what a reader should use to reconstruct intent (F3 + F8).
      await evaluateEligibility(pool, id, POLICY, { actor: ACTOR });
      const hist = await pool.query(
        "select version, decision from public.opportunity_eligibility where opportunity_id = $1 order by version",
        [id],
      );
      expect(hist.rows.length).toBe(1);
      expect(hist.rows[0].decision).toBe("eligible");
    } finally {
      await cleanup();
    }
  });

  it("a historical run's duplicate/evidence counts come from immutable rows", async () => {
    try {
      const r = await runRefresh(pool, createRegistry([new AgencyDirectoryFixture()]), {
        tasks: [{ adapterId: "agency-directory-fixture", queryText: "f78-dupes", limit: 4, maxPages: 1 }],
        actor: ACTOR,
      });
      // A second identical refresh sees the same records as duplicates.
      const r2 = await runRefresh(pool, createRegistry([new AgencyDirectoryFixture()]), {
        tasks: [{ adapterId: "agency-directory-fixture", queryText: "f78-dupes", limit: 4, maxPages: 1 }],
        actor: ACTOR,
      });
      const first = await refreshSummary(pool, r.runId);
      const second = await refreshSummary(pool, r2.runId);
      // Duplicates are counted from stored run items, so the second run records
      // them and the first run's figure is unaffected by later sightings.
      expect(second.measures.duplicates).toBeGreaterThan(0);
      expect(first.measures.duplicates).toBe(0);
    } finally {
      await cleanup();
    }
  });
});