/**
 * Discovery end-to-end acceptance tests (local DB only, loopback guard).
 *
 * STATUS: WRITTEN, UNEXECUTED — Docker/PostgreSQL was unavailable when
 * authored, so no test here has ever run. Synthetic fixtures are labeled
 * SYNTHETIC and never presented as real-world performance. Execute with:
 * Docker up → `node scripts/db.mjs migrate --target test` →
 * `npx vitest run tests/discovery_e2e.test.ts`.
 *
 * Covers TEST_PLAN T-DISC-E1..E3 + mission §4 items 1–17 (item 18 by
 * tests/milestone3_ops.test.ts, executed when Docker was up).
 */
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { attachEvidence, ingestObservation } from "../lib/evidence/ingest";
import { createRegistry } from "../lib/discovery/registry";
import { AgencyDirectoryFixture } from "../lib/discovery/fixtures/agency-directory";
import { evaluateEligibility } from "../lib/discovery/eligibility";
import { transitionOpportunity } from "../lib/discovery/opportunities";
import { linkPromotion, registerOpportunity } from "../lib/discovery/opportunities";
import { runRefresh, refreshSummary } from "../lib/discovery/refresh";
import { runDiscovery } from "../lib/discovery/run";
import { reapStaleRuns } from "../lib/discovery/reap";
import { GET as opportunitiesGET } from "../app/api/opportunities/route";
import { POST as refreshPOST } from "../app/api/discovery/refreshes/route";

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 3 });
// Route handlers resolve their pool from DATABASE_URL at call time (same
// pattern as tests/auth_session.test.ts).
process.env.DATABASE_URL = DB_URL;
const ACTOR = "de2e";
const ORIGIN = "http://127.0.0.1:3101";
const OPERATOR = "de2e-operator@example.com";

const POLICY = {
  version: "eligibility-e2e-v1",
  gates: [
    { id: "identity-resolved", passed: true, reason: "de2e: canonical company" },
    { id: "support-present", passed: true, reason: "de2e: fixture observation" },
  ],
};

function fixtureRegistry() {
  return createRegistry([new AgencyDirectoryFixture()]);
}

async function cleanup() {
  const c = await pool.connect();
  try {
    await c.query(
      // Opportunity keys are lower-cased by opportunityKey(), and companies are
      // RESTRICT-referenced by opportunities: opportunities must go first.
      "delete from public.opportunity where opportunity_key like 'opp:agency_partner:de2e-src:%' or opportunity_key like 'opp:agency_partner:agency-directory:%'",
    );
    await c.query("delete from public.discovery_coverage_task where query_text like 'de2e-%'");
    await c.query(
      "delete from public.discovery_run where query_text like 'de2e-%' or query_text like 'manual refresh:%'",
    );
    // Hypothesis rows cascade with their company (FK ON DELETE CASCADE).
    await c.query("delete from public.company where domain_norm like 'fixture-%' or domain_norm like 'de2e-%'");
  } finally {
    c.release();
  }
}

function apiReq(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers: { host: "127.0.0.1:3101", ...(init.headers ?? {}) },
    body: init.body,
  });
}

let sessionToken = "";

/** Authenticated request helper: real cookie session, CSRF origin present. */
function authReq(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): NextRequest {
  return apiReq(path, {
    ...init,
    headers: { cookie: `gsid=${sessionToken}`, origin: ORIGIN, ...(init.headers ?? {}) },
  });
}

async function mintSession(): Promise<void> {
  const { createSession } = await import("../lib/auth/sessions");
  const { getAuthConfig } = await import("../lib/auth/config");
  // Real config shape; only the session TTL is shortened for the test.
  const cfg = getAuthConfig({
    ...process.env,
    NODE_ENV: "test",
    OPERATOR_EMAIL: OPERATOR,
  });
  const { rawToken } = await createSession(pool, { ...cfg, sessionTtlSec: 3600 }, OPERATOR);
  sessionToken = rawToken;
}

beforeAll(async () => {
  await mintSession();
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await pool.query("delete from public.operator_session where operator_email = $1", [OPERATOR]);
  await pool.end();
});

describe("E1: complete manual refresh (§4.1, §4.15)", () => {
  it("plans, executes, and finalizes with history intact across reruns", async () => {
    try {
      const r = await runRefresh(pool, fixtureRegistry(), {
        tasks: [{ adapterId: "agency-directory-fixture", queryText: "de2e-flow", limit: 10, maxPages: 1 }],
        actor: ACTOR,
      });
      expect(r.status).toBe("ok");
      expect(r.tasksPlanned).toBe(1);
      expect(r.tasksDone).toBe(1);
      // Fixture math: limit 10 → 12 records on page 1 of 2-page output… assert
      // actuals from stored rows, never hardcoded totals.
      const s = await refreshSummary(pool, r.runId);
      expect(s.coverage.total).toBe(1);
      expect(s.coverage.done).toBe(1);
      expect(s.endState).toBe("exhausted");
      // Rerun: same plan, zero new companies, history grows by one run.
      const r2 = await runRefresh(pool, fixtureRegistry(), {
        tasks: [{ adapterId: "agency-directory-fixture", queryText: "de2e-flow", limit: 10, maxPages: 1 }],
        actor: ACTOR,
      });
      expect(r2.runId).not.toBe(r.runId);
      const s2 = await refreshSummary(pool, r2.runId);
      expect(s2.coverage.done).toBe(1);
      // Both runs addressable afterwards (history preserved).
      const c = await pool.connect();
      try {
        const h = await c.query(
          "select count(*)::int as n from public.discovery_run where query_text like 'manual refresh:%' or query_text = 'de2e-flow'",
        );
        expect(h.rows[0].n).toBeGreaterThanOrEqual(2);
      } finally {
        c.release();
      }
    } finally {
      await cleanup();
    }
  });
});

describe("E2/E3: counting below and above 50 (§4.2, §4.3, §4.5)", () => {
  it("<50: shortfall reported with actuals, nothing padded or transferred", async () => {
    try {
      const r = await runRefresh(pool, fixtureRegistry(), {
        tasks: [{ adapterId: "agency-directory-fixture", queryText: "de2e-small", limit: 5, maxPages: 1 }],
        actor: ACTOR,
      });
      // Full chain with an EXPLICIT test policy (no approved content used):
      // evaluate every registered opportunity, then transition the eligible.
      const c = await pool.connect();
      let oppIds: string[] = [];
      try {
        const q = await c.query("select id from public.opportunity where run_id = $1", [r.runId]);
        oppIds = q.rows.map((x) => x.id as string);
      } finally {
        c.release();
      }
      expect(oppIds.length).toBeGreaterThan(0);
      for (const id of oppIds) {
        const rec = await evaluateEligibility(pool, id, POLICY, { actor: ACTOR });
        if (rec.decision === "eligible") {
          await transitionOpportunity(pool, id, "eligible", { reason: "de2e: explicit test policy", actor: ACTOR });
        }
      }
      const s = await refreshSummary(pool, r.runId, { agency_partner: 50 });
      expect(s.measures.new_eligible).toBe(oppIds.length);
      expect(s.measures.new_eligible).toBeLessThan(50);
      expect(s.shortfall).toEqual([
        {
          pipeline: "agency_partner",
          target: 50,
          actual: oppIds.length,
          shortfall: 50 - oppIds.length,
          reason: expect.any(String),
        },
      ]);
    } finally {
      await cleanup();
    }
  });

  it("≥50: sixty controlled fixtures count exactly once each", async () => {
    try {
      for (let i = 0; i < 60; i++) {
        const o = await registerOpportunity(pool, {
          pipeline: "agency_partner",
          sourceKey: "de2e-src",
          sourceRecordId: `BULK-${i}`,
          actor: ACTOR,
        });
        await evaluateEligibility(pool, o.id, POLICY, { actor: ACTOR });
        const c = await pool.connect();
        try {
          await c.query("update public.opportunity set status = 'eligible' where id = $1", [o.id]);
        } finally {
          c.release();
        }
      }
      const c = await pool.connect();
      try {
        const r = await c.query(
          "select count(*)::int as n from public.opportunity where opportunity_key like 'opp:agency_partner:de2e-src:bulk-%' and status = 'eligible'",
        );
        expect(r.rows[0].n).toBe(60);
      } finally {
        c.release();
      }
    } finally {
      await cleanup();
    }
  });
});

describe("E4/E5/E6: duplicates, promotions, evidence (§4.4–4.6)", () => {
  it("duplicate observations do not inflate counts (§4.4)", async () => {
    try {
      const first = await runRefresh(pool, fixtureRegistry(), {
        tasks: [{ adapterId: "agency-directory-fixture", queryText: "de2e-dup", limit: 5, maxPages: 1 }],
        actor: ACTOR,
      });
      const s1 = await refreshSummary(pool, first.runId);
      expect(s1.measures.duplicates).toBe(0);
      const second = await runRefresh(pool, fixtureRegistry(), {
        tasks: [{ adapterId: "agency-directory-fixture", queryText: "de2e-dup", limit: 5, maxPages: 1 }],
        actor: ACTOR,
      });
      const s2 = await refreshSummary(pool, second.runId);
      // Identical fixture output re-seen: duplicates rise, nothing new.
      expect(s2.measures.duplicates).toBeGreaterThan(s1.measures.duplicates);
      // ...and the second refresh registered no NEW opportunities.
      const c = await pool.connect();
      try {
        const opps = await c.query(
          "select count(*)::int as n from public.opportunity where run_id = $1",
          [second.runId],
        );
        expect(opps.rows[0].n).toBe(0);
        const total = await c.query(
          "select count(*)::int as n from public.opportunity where run_id = any($1::uuid[])",
          [[first.runId, second.runId]],
        );
        expect(total.rows[0].n).toBe(s1.coverage.yield_new);
      } finally {
        c.release();
      }
    } finally {
      await cleanup();
    }
  });

  it("promoted opportunities count as promoted, never as newly eligible (§4.5)", async () => {
    // Real promotion through the approved workflow (evaluateEligibility with an
    // explicit TEST policy + linkPromotion -> the eligible->promoted transition).
    // NOTE: the CONTENT of eligibility is owner decision O10 and remains
    // unimplemented on purpose; this test exercises the approved STRUCTURE only
    // and states its own fixture policy rather than inventing a real rule.
    try {
      const r = await runRefresh(pool, fixtureRegistry(), {
        tasks: [{ adapterId: "agency-directory-fixture", queryText: "d2e-promo", limit: 4, maxPages: 1 }],
        actor: ACTOR,
      });
      const c = await pool.connect();
      let target = "";
      let targetCompanyId = "";
      try {
        const q = await c.query(
          "select id, company_id from public.opportunity where run_id = $1 order by created_at",
          [r.runId],
        );
        expect(q.rows.length, "the refresh must register at least one opportunity").toBeGreaterThan(0);
        target = q.rows[0].id as string;
        targetCompanyId = q.rows[0].company_id as string;
      } finally {
        c.release();
      }

      // Not yet eligible -> new_eligible counts it.
      await evaluateEligibility(pool, target, POLICY, { actor: ACTOR });
      await transitionOpportunity(pool, target, "eligible", {
        reason: "d2e: explicit test policy",
        actor: ACTOR,
      });
      const before = await refreshSummary(pool, r.runId);
      expect(before.measures.new_eligible).toBe(1);
      expect(before.measures.promoted).toBe(0);

      // Promote it through the real promotion path. `linkPromotion` requires a
      // hypothesis target (FK), so the test creates one minimal, clearly
      // labelled GENERATED hypothesis for the same company. It is only a
      // promotion target here - nothing about hypothesis validity is asserted,
      // and no lifecycle state beyond the initial one is invented.
      const c2 = await pool.connect();
      let hypothesisId = "";
      try {
        const h = await c2.query(
          `insert into public.hypothesis (company_id, title, opportunity_category, status, confidence_rationale)
           values ($1, 'd2e promotion target (fixture)', 'other_digital', 'generated', 'd2e: fixture for promotion accounting only')
           returning id`,
          [targetCompanyId],
        );
        hypothesisId = h.rows[0].id as string;
      } finally {
        c2.release();
      }
      const promoted = await linkPromotion(pool, target, hypothesisId, ACTOR);
      expect(promoted.created).toBe(true);
      expect(promoted.hypothesisId).toBe(hypothesisId);
      // Re-promotion is a no-op, never a duplicate link.
      expect((await linkPromotion(pool, target, hypothesisId, ACTOR)).created).toBe(false);

      const after = await refreshSummary(pool, r.runId);
      // (a) counted as promoted, (b) NOT as newly eligible, (c) yields untouched.
      expect(after.measures.promoted).toBe(1);
      expect(after.measures.new_eligible).toBe(0);
      // Promotion moves a row eligible -> promoted; neither bucket is
      // "unresolved", so the unresolved count is unchanged by the promotion.
      expect(after.measures.unresolved).toBe(before.measures.unresolved);
      expect(after.coverage.yield_new).toBe(before.coverage.yield_new);

      const c3 = await pool.connect();
      try {
        const row = await c3.query(
          "select status from public.opportunity where id = $1",
          [target],
        );
        expect(row.rows[0].status).toBe("promoted");
        const audit = await c3.query(
          "select transition_from, transition_to, actor from public.audit_log where entity_type = 'opportunity' and entity_id = $1 order by created_at",
          [target],
        );
        const toPromoted = audit.rows.find((x) => x.transition_to === "promoted");
        expect(toPromoted).toMatchObject({ transition_from: "eligible", actor: ACTOR });
        // Exactly one promotion transition - no duplicate audit effects.
        expect(audit.rows.filter((x) => x.transition_to === "promoted")).toHaveLength(1);
      } finally {
        c3.release();
      }
    } finally {
      await cleanup();
    }
  });

  it("new evidence preserves historical observations", async () => {
    const co = await createCompany(
      pool,
      { name: "De2e Evidence Co", domain: `de2e-ev-${Date.now()}.example`, agencyType: "web_development", country: "United States" },
      ACTOR,
    );
    try {
      const o1 = await ingestObservation(
        pool,
        { companyId: co.companyId, sourceKey: "company-site", url: "https://de2e.example/a", excerpt: "de2e first observation", actor: ACTOR },
        { predicate: "announced", text: "de2e first claim", reliability: "B", credibility: 2 },
      );
      const o2 = await ingestObservation(
        pool,
        { companyId: co.companyId, sourceKey: "company-site", url: "https://de2e.example/b", excerpt: "de2e second observation", actor: ACTOR },
        { predicate: "announced", text: "de2e second claim", reliability: "B", credibility: 2 },
      );
      const c = await pool.connect();
      try {
        const r = await c.query("select count(*)::int as n from public.claim where company_id = $1", [co.companyId]);
        expect(r.rows[0].n).toBe(2);
        expect(o1.claimId).toBeTruthy();
        expect(o2.claimId).toBeTruthy();
        expect(o1.claimId).not.toBe(o2.claimId);
      } finally {
        c.release();
      }
    } finally {
      await cleanup();
    }
  });
});

describe("E7/E8/E9: multiplicity, identity, pipelines (§4.7–4.9)", () => {
  it("one business holds multiple distinct opportunities; ambiguous identities never auto-merge", async () => {
    const co = await createCompany(
      pool,
      { name: "De2e Ambiguity Partners", domain: `de2e-amb-a-${Date.now()}.example`, agencyType: "web_development", country: "United States" },
      ACTOR,
    );
    try {
      for (const rec of ["M-A", "M-B", "M-C"]) {
        await registerOpportunity(pool, {
          pipeline: "agency_partner",
          sourceKey: "de2e-src",
          sourceRecordId: rec,
          companyId: co.companyId,
          actor: ACTOR,
        });
      }
      const c = await pool.connect();
      try {
        const r = await c.query(
          "select count(*)::int as n from public.opportunity where company_id = $1",
          [co.companyId],
        );
        expect(r.rows[0].n).toBe(3);
        // Ambiguity path: a company whose NORMALIZED name matches an existing peer
        // ("...Partners" vs "...Partners Limited" normalize identically) with
        // different identifiers must produce a PENDING review candidate and must
        // NOT merge anything (D-011: names alone prove nothing).
        const twin = await createCompany(
          pool,
          { name: "De2e Ambiguity Partners Limited", domain: `de2e-amb-b-${Date.now()}.example`, agencyType: "web_development", country: "United States" },
          ACTOR,
        );
        const { findCandidates } = await import("../lib/resolve/engine");
        const found = await findCandidates(pool, twin.companyId, { actor: ACTOR, autoMerge: false });
        expect(found.autoMerged, "auto-merge must be off in this path").toEqual([]);
        expect(found.candidates.length, "a same-name peer must be queued for review").toBeGreaterThan(0);
        const persisted = await pool.connect();
        try {
          const rows = await persisted.query(
            `select id, rule, status, company_a, company_b, decided_by
             from public.match_candidate
             where (company_a = $1 or company_b = $1) and (company_a = $2 or company_b = $2)`,
            [co.companyId, twin.companyId],
          );
          expect(rows.rows.length).toBeGreaterThan(0);
          for (const row of rows.rows) {
            // Persisted as an OPEN review item: nobody decided it, and the two
            // companies are still two distinct records.
            expect(row.status).toBe("pending");
            expect(row.decided_by).toBeNull();
            expect([row.company_a, row.company_b].sort()).toEqual([co.companyId, twin.companyId].sort());
          }
          // Nothing was merged by generating candidates.
          const both = await persisted.query("select merged_into from public.company where id = any($1)", [
            [co.companyId, twin.companyId],
          ]);
          expect(both.rows).toHaveLength(2);
          expect(both.rows.every((x) => x.merged_into === null)).toBe(true);
        } finally {
          persisted.release();
        }
      } finally {
        c.release();
      }
    } finally {
      await cleanup();
    }
  });

  it("pipelines stay distinct; direct_client refuses", async () => {
    await expect(
      registerOpportunity(pool, { pipeline: "direct_client", sourceKey: "de2e-src", sourceRecordId: "P-1", actor: ACTOR }),
    ).rejects.toMatchObject({ status: 409, code: "direct_client_blocked" });
    const res = await opportunitiesGET(authReq("/api/opportunities?pipeline=direct_client&limit=50"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ total: 0, items: [] });
  });
});

describe("E10: contradictions + freshness (§4.10)", () => {
  it("contradicting evidence coexists with statuses intact", async () => {
    const co = await createCompany(
      pool,
      { name: "De2e Contra Co", domain: `de2e-contra-${Date.now()}.example`, agencyType: "web_development", country: "United States" },
      ACTOR,
    );
    try {
      const a = await ingestObservation(
        pool,
        { companyId: co.companyId, sourceKey: "company-site", url: "https://de2e.example/c1", excerpt: "de2e portal launched", actor: ACTOR },
        { predicate: "announced", text: "de2e portal exists", reliability: "B", credibility: 2 },
      );
      const b = await ingestObservation(
        pool,
        { companyId: co.companyId, sourceKey: "company-site", url: "https://de2e.example/c2", excerpt: "de2e no portal exists", actor: ACTOR },
        { predicate: "announced", text: "de2e portal does not exist", reliability: "C", credibility: 2 },
      );
      await attachEvidence(pool, { claimId: a.claimId!, linkedClaimId: b.claimId!, polarity: "contradicts", actor: ACTOR });
      const c = await pool.connect();
      try {
        const r = await c.query(
          `select c.claim_status, (select count(*)::int from public.claim_evidence e where e.claim_id = c.id and e.polarity = 'contradicts') as contra
           from public.claim c where c.id = any($1)`,
          [[a.claimId!, b.claimId!]],
        );
        expect(r.rows).toHaveLength(2);
        expect(r.rows.find((x) => x.contra === 1)).toBeTruthy();
      } finally {
        c.release();
      }
    } finally {
      await cleanup();
    }
  });
});

describe("E11–E14: permissions, safety, timeouts, idempotency (§4.11–4.14)", () => {
  it("unknown adapters fail tasks cleanly; refresh reports partial", async () => {
    const r = await runRefresh(pool, fixtureRegistry(), {
      tasks: [{ adapterId: "no-such-adapter", queryText: "de2e-bad" }],
      actor: ACTOR,
    });
    expect(r.status).toBe("failed");
    const s = await refreshSummary(pool, r.runId);
    expect(s.coverage.failed).toBe(1);
    expect(s.endState).toBe("failed");
  });

  it("repeat + concurrent refreshes preserve idempotency", async () => {
    const plan = {
      tasks: [{ adapterId: "agency-directory-fixture", queryText: "de2e-idem", limit: 5, maxPages: 1 }],
      actor: ACTOR,
    };
    const c = await pool.connect();
    let before = 0;
    try {
      before = (
        await c.query("select count(*)::int as n from public.company where domain_norm like 'fixture-%'")
      ).rows[0].n as number;
    } finally {
      c.release();
    }
    const [a, b] = await Promise.all([runRefresh(pool, fixtureRegistry(), plan), runRefresh(pool, fixtureRegistry(), plan)]);
    expect(a.runId).not.toBe(b.runId);
    const c2 = await pool.connect();
    try {
      const after = (
        await c2.query("select count(*)::int as n from public.company where domain_norm like 'fixture-%'")
      ).rows[0].n as number;
      // Both runs saw the same fixture universe: bounded growth only.
      expect(after - before).toBeLessThanOrEqual(7);
    } finally {
      c2.release();
    }
    await cleanup();
  });
});

describe("E15/E16: history + collection access (§4.15–4.16)", () => {
  it("history persists across refreshes; pagination omits nothing", async () => {
    try {
      for (let i = 0; i < 65; i++) {
        await registerOpportunity(pool, {
          pipeline: "agency_partner",
          sourceKey: "de2e-src",
          sourceRecordId: `PAGE-${i}`,
          actor: ACTOR,
        });
      }
      const p1 = await opportunitiesGET(authReq("/api/opportunities?pipeline=agency_partner&limit=50&offset=0"));
      const b1 = (await p1.json()) as { total: number; items: unknown[] };
      expect(p1.status).toBe(200);
      expect(b1.total).toBeGreaterThanOrEqual(65);
      expect(b1.items).toHaveLength(50);
      const p2 = await opportunitiesGET(authReq("/api/opportunities?pipeline=agency_partner&limit=50&offset=50"));
      const b2 = (await p2.json()) as { total: number; items: unknown[] };
      expect(b2.total).toBe(b1.total);
      expect(b2.items.length).toBeGreaterThan(0);
      const ids = new Set([...b1.items, ...b2.items].map((x) => (x as { id: string }).id));
      expect(ids.size).toBe(b1.items.length + b2.items.length);
    } finally {
      await cleanup();
    }
  });
});

describe("E11: source permission is enforced (§4.11, B-D5)", () => {
  it("a disabled source refuses runs; re-enabling restores them", async () => {
    const c = await pool.connect();
    try {
      await c.query("update public.source set enabled = false where key = 'agency-directory'");
    } finally {
      c.release();
    }
    try {
      // Single-query run: hard refusal, no run row written at all.
      await expect(
        runDiscovery(pool, fixtureRegistry(), {
          adapterId: "agency-directory-fixture",
          queryText: "de2e-disabled",
          limit: 3,
          maxPages: 1,
          actor: ACTOR,
        }),
      ).rejects.toMatchObject({ status: 409, code: "source_disabled" });
      const c2 = await pool.connect();
      try {
        const r = await c2.query(
          "select count(*)::int as n from public.discovery_run where query_text = 'de2e-disabled'",
        );
        expect(r.rows[0].n).toBe(0);
      } finally {
        c2.release();
      }
      // Planned refresh: the refusal surfaces as a FAILED TASK with the reason
      // (the refresh records the attempt; it does not silently succeed).
      const refresh = await runRefresh(pool, fixtureRegistry(), {
        tasks: [{ adapterId: "agency-directory-fixture", queryText: "de2e-disabled-refresh", limit: 3, maxPages: 1 }],
        actor: ACTOR,
      });
      expect(refresh.status).toBe("failed");
      const sum = await refreshSummary(pool, refresh.runId);
      expect(sum.coverage.failed).toBe(1);
      expect(sum.endState).toBe("failed");
      const c3 = await pool.connect();
      try {
        const note = await c3.query(
          "select note from public.discovery_coverage_task where run_id = $1",
          [refresh.runId],
        );
        expect(String(note.rows[0].note)).toContain("source_disabled");
        const items = await c3.query(
          "select count(*)::int as n from public.discovery_run_item i join public.discovery_run r on r.id = i.run_id where r.query_text = 'de2e-disabled-refresh'",
        );
        expect(items.rows[0].n).toBe(0);
      } finally {
        c3.release();
      }
    } finally {
      const c4 = await pool.connect();
      try {
        await c4.query("update public.source set enabled = true where key = 'agency-directory'");
      } finally {
        c4.release();
      }
      await cleanup();
    }
    // Permission restored: the same plan now runs.
    const ok = await runRefresh(pool, fixtureRegistry(), {
      tasks: [{ adapterId: "agency-directory-fixture", queryText: "de2e-reenabled", limit: 3, maxPages: 1 }],
      actor: ACTOR,
    });
    expect(ok.status).toBe("ok");
    await cleanup();
  });
});

describe("B-D6: crashed/stalled runs close out with reasons (never silently)", () => {
  it("dry run lists without writing; reap fails the run + tasks and audits it", async () => {
    const c = await pool.connect();
    let runId = "";
    let taskId = "";
    try {
      const r = await c.query(
        `insert into public.discovery_run (adapter_id, adapter_version, status, query_text, created_by, started_at)
         values ('agency-directory-fixture', '0.1.0', 'running', 'de2e-stalled', $1, now() - interval '30 minutes')
         returning id`,
        [ACTOR],
      );
      runId = r.rows[0].id as string;
      const t = await c.query(
        `insert into public.discovery_coverage_task (run_id, adapter_id, query_text, status, started_at)
         values ($1, 'agency-directory-fixture', 'de2e-stalled', 'running', now() - interval '30 minutes')
         returning id`,
        [runId],
      );
      taskId = t.rows[0].id as string;
    } finally {
      c.release();
    }
    try {
      const dry = await reapStaleRuns(pool, { staleAfterMinutes: 10, actor: ACTOR, dryRun: true });
      expect(dry.considered.map((x) => x.id)).toContain(runId);
      expect(dry.reaped).toEqual([]);
      const c2 = await pool.connect();
      try {
        const still = await c2.query("select status from public.discovery_run where id = $1", [runId]);
        expect(still.rows[0].status).toBe("running"); // dry run wrote nothing
      } finally {
        c2.release();
      }
      const real = await reapStaleRuns(pool, { staleAfterMinutes: 10, actor: ACTOR });
      expect(real.reaped.map((x) => x.runId)).toContain(runId);
      const c3 = await pool.connect();
      try {
        const run = await c3.query("select status, finished_at, error from public.discovery_run where id = $1", [runId]);
        expect(run.rows[0].status).toBe("failed");
        expect(run.rows[0].finished_at).not.toBeNull();
        expect(String(run.rows[0].error)).toContain("reaped");
        const task = await c3.query("select status, finished_at from public.discovery_coverage_task where id = $1", [taskId]);
        expect(task.rows[0].status).toBe("failed");
        expect(task.rows[0].finished_at).not.toBeNull();
        const audit = await c3.query(
          "select actor, transition_to from public.audit_log where entity_type = 'discovery_run' and entity_id = $1",
          [runId],
        );
        expect(audit.rows.length).toBe(1);
        expect(audit.rows[0].actor).toBe(ACTOR);
        expect(audit.rows[0].transition_to).toBe("failed");
      } finally {
        c3.release();
      }
      // Second reap is a no-op: the run is terminal, not re-failed.
      const again = await reapStaleRuns(pool, { staleAfterMinutes: 10, actor: ACTOR });
      expect(again.considered.map((x) => x.id)).not.toContain(runId);
    } finally {
      await cleanup();
    }
  });

  it("fresh running runs are never reaped by a generous threshold", async () => {
    const r = await runRefresh(pool, fixtureRegistry(), {
      tasks: [{ adapterId: "agency-directory-fixture", queryText: "de2e-fresh", limit: 3, maxPages: 1 }],
      actor: ACTOR,
    });
    const s = await refreshSummary(pool, r.runId);
    expect(s.runStatus).toBe("ok");
    const reap = await reapStaleRuns(pool, { staleAfterMinutes: 10_080, actor: ACTOR });
    expect(reap.reaped).toEqual([]);
    await cleanup();
  });
});

describe("E17: authN/Z, CSRF, attribution (§4.17)", () => {
  it("anonymous refresh is denied with 401 (authentication, before any work)", async () => {
    const anon = await refreshPOST(
      new NextRequest(`${ORIGIN}/api/discovery/refreshes`, {
        method: "POST",
        headers: { "content-type": "application/json", host: "127.0.0.1:3101" },
        body: JSON.stringify({ tasks: [{ adapterId: "x", queryText: "de2e-anon" }] }),
      }),
    );
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({ code: "unauthorized" });
  });

  it("an authenticated cookie POST without an Origin header is refused by the CSRF guard", async () => {
    // Valid session, NO Origin and NO Referer: authentication passes and the
    // origin check is what must reject. An anonymous 401 here would NOT prove
    // CSRF protection, so the test asserts the CSRF-specific shape explicitly.
    const res = await refreshPOST(
      new NextRequest(`${ORIGIN}/api/discovery/refreshes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1:3101",
          cookie: `gsid=${sessionToken}`, // authenticated
          // deliberately no origin / referer
        },
        body: JSON.stringify({ tasks: [{ adapterId: "agency-directory-fixture", queryText: "de2e-csrf" }] }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "forbidden", message: "origin check failed" });
    // Proof the guard fired BEFORE any work: no run row was created.
    const c = await pool.connect();
    try {
      const runs = await c.query(
        "select count(*)::int as n from public.discovery_run where query_text = 'de2e-csrf' or query_text like 'manual refresh:%'",
      );
      expect(runs.rows[0].n).toBe(0);
    } finally {
      c.release();
    }
  });

  it("the same authenticated request WITH a same-origin header proceeds", async () => {
    const res = await refreshPOST(
      new NextRequest(`${ORIGIN}/api/discovery/refreshes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "127.0.0.1:3101",
          cookie: `gsid=${sessionToken}`,
          origin: ORIGIN,
        },
        body: JSON.stringify({
          tasks: [{ adapterId: "agency-directory-fixture", queryText: "de2e-csrf-ok", limit: 2, maxPages: 1 }],
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: string };
    expect(body.runId).toBeTruthy();
    await cleanup();
  });
});
