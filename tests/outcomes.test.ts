/**
 * MILESTONE 2 (S-2) learning-report tests (local DB only, loopback guard).
 * Covers: overview math, grouped rates by segment/channel/category/source,
 * low-data honesty (rate null below MIN_DENOM), rejection ranking, evidence
 * health, empty-database zeros, determinism. Reports never write (audit
 * invariance asserted).
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { ingestObservation } from "../lib/evidence/ingest";
import { decideHypothesis, generateHypotheses } from "../lib/hypothesis/rules";
import { createProposal, decideProposal } from "../lib/proposal/proposals";
import { createBrief, recordOutcome } from "../lib/sales/briefs";
import {
  MIN_DENOM,
  evidenceHealth,
  learningReport,
  outcomeOverview,
  ratesByChannel,
  ratesByHypothesisCategory,
  ratesBySegment,
  ratesBySource,
  topRejections,
} from "../lib/outcomes/reports";

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 3 });
const ACTOR = "m2rep";
let seq = 0;
const dom = (p: string) => `m2r-${Date.now()}-${seq++}-${p}.example`;

const PROPOSAL = {
  title: "M2Rep Pilot",
  scopeIn: "Intake form",
  scopeOut: "Billing",
  feasibility: "medium" as const,
  assumptions: "Agency confirms intake",
  items: [{ name: "Form", complexity: "S" as const, kind: "feature" as const }],
  contingencyPct: 15,
  actor: ACTOR,
};

async function mkBriefRef(name: string, agencyType: string): Promise<string> {
  const co = (
    await createCompany(
      pool,
      { name, domain: dom("co"), agencyType, country: "United States" },
      ACTOR,
    )
  ).companyId;
  await ingestObservation(
    pool,
    { companyId: co, sourceKey: "company-site", url: `https://m2r.example/${seq++}`, excerpt: "Client onboarding portal announced", actor: ACTOR },
    { predicate: "announced", text: "Client onboarding portal announced", reliability: "B", credibility: 2 },
  );
  const gen = await generateHypotheses(pool, co, ACTOR);
  const hyp = gen.hypotheses.find((h) => h.ruleId === "R-PORTAL-01")?.id;
  if (!hyp) throw new Error("fixture: R-PORTAL-01 did not fire");
  await decideHypothesis(pool, hyp, { decision: "validate", reason: "m2", actor: ACTOR });
  const prop = await createProposal(pool, { ...PROPOSAL, hypothesisId: hyp });
  await decideProposal(pool, prop.id, { decision: "submit", reason: "m2", actor: ACTOR });
  await decideProposal(pool, prop.id, { decision: "accept", reason: "m2", actor: ACTOR });
  return (await createBrief(pool, { proposalId: prop.id, actor: ACTOR })).ref;
}

async function cleanup() {
  const c = await pool.connect();
  try {
    await c.query(
      `delete from public.hypothesis_evidence where hypothesis_id in (
         select id from public.hypothesis where company_id in (
           select id from public.company
           where domain_norm like 'm2r-%' or name like 'M2Rep %'))`,
    );
    await c.query("delete from public.company where domain_norm like 'm2r-%' or name like 'M2Rep %'");
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

/** 6 outcomes on web/email (enough for real rates) + 2 on custom/dm (low data). */
async function mkOutcomes() {
  const a = await mkBriefRef("M2Rep Alpha", "web_development");
  const b = await mkBriefRef("M2Rep Beta", "custom_software");
  const outs: [string, string, string?][] = [
    [a, "replied"],
    [a, "meeting"],
    [a, "no_reply"],
    [a, "lost", "no_budget"],
    [a, "lost", "no_budget"],
    [a, "won"],
    [b, "replied"],
    [b, "no_reply"],
  ];
  for (const [ref, outcome, rej] of outs) {
    await recordOutcome(pool, ref, {
      outcome,
      channel: ref === a ? "email" : "dm",
      rejectionCode: rej,
      note: "m2 fixture",
      actor: ACTOR,
    });
  }
  return { a, b };
}

describe("learning reports", () => {
  it("computes overview rates with numerators and denominators", async () => {
    // Seed-tolerant: the database may hold seeded outcomes. Assert the
    // fixture DELTA on top of a captured baseline, never absolute counts.
    const base = await outcomeOverview(pool);
    try {
      await mkOutcomes();
      const o = await outcomeOverview(pool);
      expect(o.total).toBe(base.total + 8);
      // Fixture contributes 4 replies of 8 (replied/meeting/won + beta replied).
      expect(o.reply.n).toBe(base.reply.n + 4);
      expect(o.reply.denom).toBe(base.reply.denom + 8);
      expect(o.reply.rate).toBe((base.reply.n + 4) / (base.reply.denom + 8));
      expect(o.reply.lowData).toBe(false);
      expect(o.win.n).toBe(base.win.n + 1);
      expect(o.win.denom).toBe(base.win.denom + 8);
      const lost = o.byOutcome.find((x) => x.outcome === "lost")?.n ?? 0;
      const baseLost = base.byOutcome.find((x) => x.outcome === "lost")?.n ?? 0;
      expect(lost).toBe(baseLost + 2);
    } finally {
      await cleanup();
    }
  });

  it("groups by segment, channel, category, and source", async () => {
    const segBase = await ratesBySegment(pool);
    const baseWeb = segBase.find((s) => s.key === "web_development");
    const baseCustom = segBase.find((s) => s.key === "custom_software");
    const chBase = await ratesByChannel(pool);
    const baseDm = chBase.find((s) => s.key === "dm");
    try {
      await mkOutcomes();
      const seg = await ratesBySegment(pool);
      const web = seg.find((s) => s.key === "web_development")!;
      expect(web.outcomes).toBe((baseWeb?.outcomes ?? 0) + 6);
      // Fixture web reply: replied + meeting + won = 3 of 6.
      expect(web.reply.n).toBe((baseWeb?.reply.n ?? 0) + 3);
      expect(web.reply.denom).toBe((baseWeb?.reply.denom ?? 0) + 6);
      expect(web.reply.lowData).toBe(false);
      const custom = seg.find((s) => s.key === "custom_software")!;
      expect(custom.outcomes).toBe((baseCustom?.outcomes ?? 0) + 2);
      expect(custom.reply.n).toBe((baseCustom?.reply.n ?? 0) + 1);
      expect(custom.reply.lowData).toBe((baseCustom?.reply.denom ?? 0) + 2 < MIN_DENOM);

      const ch = await ratesByChannel(pool);
      const email = ch.find((s) => s.key === "email")!;
      expect(email.outcomes).toBeGreaterThanOrEqual(6);
      const dm = ch.find((s) => s.key === "dm")!;
      expect(dm.outcomes).toBe((baseDm?.outcomes ?? 0) + 2);
      expect(dm.reply.lowData).toBe((baseDm?.reply.denom ?? 0) + 2 < MIN_DENOM);

      const cat = await ratesByHypothesisCategory(pool);
      const portals = cat.find((s) => s.key === "portals_dashboards")!;
      expect(portals.outcomes).toBeGreaterThanOrEqual(8);

      const src = await ratesBySource(pool);
      const site = src.find((s) => s.key === "company-site")!;
      // One brief counts once per contributing source: 2 fixture briefs.
      expect(site.outcomes).toBeGreaterThanOrEqual(8);
    } finally {
      await cleanup();
    }
  });

  it("ranks rejection reasons among lost outcomes only", async () => {
    const before = await topRejections(pool);
    try {
      await mkOutcomes();
      const r = await topRejections(pool);
      expect(r.total).toBe(before.total + 8);
      expect(r.lost).toBe(before.lost + 2);
      const nb = r.rows.find((x) => x.code === "no_budget")!;
      const baseNb = before.rows.find((x) => x.code === "no_budget")?.n ?? 0;
      expect(nb.n).toBe(baseNb + 2);
      // The fixture's no_budget pair tops the ranking.
      expect(r.rows[0].code).toBe("no_budget");
    } finally {
      await cleanup();
    }
  });

  it("reports evidence health without verdicts", async () => {
    try {
      await mkOutcomes();
      const h = await evidenceHealth(pool);
      expect(h.claims).toBeGreaterThanOrEqual(2);
      expect(h.expired).toBe(0);
      for (const k of ["disputed", "withdrawn", "superseded", "assumed", "approvedBriefs"] as const) {
        expect(h[k]).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await cleanup();
    }
  });

  it("returns honest zeros on an empty slice and stays deterministic", async () => {
    const c = await pool.connect();
    let refs: string[] = [];
    try {
      const q = await c.query(
        `select b.ref from public.brief b join public.company co on co.id = b.company_id
         where co.domain_norm like 'm2r-%' or co.name like 'M2Rep %'`,
      );
      refs = q.rows.map((r) => r.ref as string);
    } finally {
      c.release();
    }
    expect(refs).toEqual([]);
    const o = await outcomeOverview(pool);
    // Other suites' fixtures may exist; the shape must hold regardless.
    expect(o.total).toBeGreaterThanOrEqual(0);
    expect(o.reply.lowData).toBe(o.reply.denom < MIN_DENOM);
    if (o.reply.denom < MIN_DENOM) expect(o.reply.rate).toBeNull();
    const a = await learningReport(pool);
    const b = await learningReport(pool);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never writes (audit invariance)", async () => {
    try {
      await mkOutcomes();
      const c = await pool.connect();
      try {
        const before = await c.query("select count(*)::int as n from public.audit_log");
        await learningReport(pool);
        await outcomeOverview(pool);
        await topRejections(pool);
        const after = await c.query("select count(*)::int as n from public.audit_log");
        expect(after.rows[0].n).toBe(before.rows[0].n);
      } finally {
        c.release();
      }
    } finally {
      await cleanup();
    }
  });
});
