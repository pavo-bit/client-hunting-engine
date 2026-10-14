/**
 * MILESTONE 2 (S-1) global search tests (local DB only, loopback guard).
 * Covers: every domain hit, deterministic ranking (exact > prefix >
 * substring), totals vs caps, input validation, merged-record exclusion,
 * injection-string safety, determinism across reads. Auth on the endpoint is
 * covered by the guard contract (all /api/* require auth) + HTTP smoke.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { ingestObservation } from "../lib/evidence/ingest";
import { decideHypothesis, generateHypotheses } from "../lib/hypothesis/rules";
import { createProposal, decideProposal } from "../lib/proposal/proposals";
import { createBrief } from "../lib/sales/briefs";
import {
  SEARCH_MAX_PER_DOMAIN,
  globalSearch,
} from "../lib/search/global";

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 3 });
const ACTOR = "m2search";
let seq = 0;
const dom = (p: string) => `m2s-${Date.now()}-${seq++}-${p}.example`;

async function mkCo(name: string) {
  return (
    await createCompany(
      pool,
      { name, domain: dom("co"), agencyType: "web_development", country: "United States" },
      ACTOR,
    )
  ).companyId;
}

async function mkClaim(companyId: string, text: string) {
  const r = await ingestObservation(
    pool,
    { companyId, sourceKey: "company-site", url: `https://m2s.example/${seq++}`, excerpt: text.slice(0, 300), actor: ACTOR },
    { predicate: "announced", text, reliability: "B", credibility: 2 },
  );
  return r.claimId!;
}

async function cleanup() {
  const c = await pool.connect();
  try {
    await c.query(
      `delete from public.hypothesis_evidence where hypothesis_id in (
         select id from public.hypothesis where company_id in (
           select id from public.company
           where domain_norm like 'm2s-%' or name like 'M2Search %'))`,
    );
    await c.query("delete from public.company where domain_norm like 'm2s-%' or name like 'M2Search %'");
  } finally {
    c.release();
  }
}

const PROPOSAL = {
  title: "M2Search Portal Pilot",
  scopeIn: "Intake form, status page",
  scopeOut: "Billing migration",
  feasibility: "medium" as const,
  assumptions: "Agency confirms email intake",
  items: [{ name: "Intake form", complexity: "M" as const, kind: "feature" as const }],
  contingencyPct: 15,
  actor: ACTOR,
};

beforeAll(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

async function mkWorld() {
  const co = await mkCo("M2Search Portalworks");
  await mkClaim(co, "Client onboarding portal announced for M2Search Portalworks");
  const gen = await generateHypotheses(pool, co, ACTOR);
  const hyp = gen.hypotheses.find((h) => h.ruleId === "R-PORTAL-01")?.id;
  if (!hyp) throw new Error("fixture: R-PORTAL-01 did not fire");
  await decideHypothesis(pool, hyp, { decision: "validate", reason: "m2", actor: ACTOR });
  const prop = await createProposal(pool, { ...PROPOSAL, hypothesisId: hyp });
  await decideProposal(pool, prop.id, { decision: "submit", reason: "m2", actor: ACTOR });
  await decideProposal(pool, prop.id, { decision: "accept", reason: "m2", actor: ACTOR });
  const brief = await createBrief(pool, { proposalId: prop.id, actor: ACTOR });
  return { co, hyp, prop: prop.id, brief: brief.ref };
}

describe("global search", () => {
  it("finds matches in all five domains with totals and deep links", async () => {
    try {
      const w = await mkWorld();
      // "M2Search Portal" hits the company row by name; claims, hypotheses,
      // proposals, and briefs match through their owning-company name even
      // where their own titles lack the token (company-aware matching).
      const r = await globalSearch(pool, "M2Search Portal");
      expect(r.query).toBe("M2Search Portal");
      expect(r.companies.total).toBeGreaterThanOrEqual(1);
      expect(r.claims.total).toBeGreaterThanOrEqual(1);
      expect(r.hypotheses.total).toBeGreaterThanOrEqual(1);
      expect(r.proposals.total).toBeGreaterThanOrEqual(1);
      expect(r.briefs.total).toBeGreaterThanOrEqual(1);
      // Merged-record coherence + deep links.
      for (const g of [r.companies, r.claims, r.hypotheses, r.proposals, r.briefs]) {
        for (const hit of g.rows) {
          expect(hit.id.length).toBeGreaterThan(0);
          expect(hit.href.startsWith("/")).toBe(true);
          expect(hit.companyName).toContain("M2Search");
        }
      }
      expect(r.companies.rows[0].href).toBe(`/agencies/${w.co}`);
      expect(r.hypotheses.rows[0].href).toBe(`/hypotheses/${w.hyp}`);
      expect(r.proposals.rows[0].href).toBe(`/proposals/${w.prop}`);
      expect(r.briefs.rows[0].href).toBe(`/briefs/${w.brief}`);
    } finally {
      await cleanup();
    }
  });

  it("finds a company's hypotheses, proposals, and briefs by company name", async () => {
    try {
      const w = await mkWorld();
      // None of these titles contain "Portalworks" — only the company name does.
      const r = await globalSearch(pool, "Portalworks");
      expect(r.hypotheses.rows.map((x) => x.id)).toContain(w.hyp);
      expect(r.proposals.rows.map((x) => x.id)).toContain(w.prop);
      expect(r.briefs.rows.map((x) => x.id)).toContain(w.brief);
      expect(r.claims.rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup();
    }
  });
  it("ranks exact matches before prefix and substring matches", async () => {
    const exact = await mkCo("M2Search Exactname");
    const prefix = await mkCo("M2Search Exactname Solutions");
    try {
      const r = await globalSearch(pool, "M2Search Exactname", 50);
      const ids = r.companies.rows.map((x) => x.id);
      // Exact company name first, prefix second (both before any substring).
      expect(ids[0]).toBe(exact);
      expect(ids[1]).toBe(prefix);
    } finally {
      await cleanup();
    }
  });

  it("bounds pages, reports totals, and validates input", async () => {
    try {
      await mkWorld();
      const capped = await globalSearch(pool, "M2Search", 2);
      for (const g of [capped.companies, capped.claims, capped.hypotheses, capped.proposals, capped.briefs]) {
        expect(g.rows.length).toBeLessThanOrEqual(2);
        expect(g.total).toBeGreaterThanOrEqual(g.rows.length);
      }
      await expect(globalSearch(pool, "")).rejects.toMatchObject({ status: 422, code: "bad_query" });
      await expect(globalSearch(pool, "x")).rejects.toMatchObject({ status: 422 });
      await expect(globalSearch(pool, "   ")).rejects.toMatchObject({ status: 422 });
      const big = await globalSearch(pool, "M2Search", 99999);
      expect(big.perDomain).toBe(SEARCH_MAX_PER_DOMAIN);
      const empty = await globalSearch(pool, "zzz-no-such-token-zzz");
      expect(empty.companies.total).toBe(0);
      expect(empty.companies.rows).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("is deterministic across reads", async () => {
    try {
      await mkWorld();
      const a = await globalSearch(pool, "portal");
      const b = await globalSearch(pool, "portal");
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    } finally {
      await cleanup();
    }
  });

  it("treats hostile input as data (parameterized, no wildcard tricks)", async () => {
    try {
      await mkWorld();
      // SQL metacharacters must not leak or multiply rows.
      const evil = await globalSearch(pool, `' OR '1'='1`);
      expect(evil.companies.total).toBe(0);
      // A lone wildcard is too short to search: rejected, not executed.
      await expect(globalSearch(pool, `%`)).rejects.toMatchObject({ status: 422 });
    } finally {
      await cleanup();
    }
  });

  it("excludes merged-away company records", async () => {
    const co = await mkCo("M2Search Mergee");
    try {
      const twin = await mkCo("M2Search Mergee Ltd");
      const { findCandidates, decideCandidate } = await import("../lib/resolve/engine");
      const r = await findCandidates(pool, twin, { actor: ACTOR, autoMerge: false });
      expect(r.candidates.length).toBeGreaterThan(0);
      await decideCandidate(pool, r.candidates[0].id, { decision: "accepted", reason: "m2 same", actor: ACTOR });
      const q = await globalSearch(pool, "M2Search Mergee", 50);
      expect(q.companies.rows.every((x) => x.id !== twin)).toBe(true);
      void co;
    } finally {
      await cleanup();
    }
  });
});
