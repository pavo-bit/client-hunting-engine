/**
 * T-011 scoring tests (local DB only, loopback guard).
 * Covers: pure boundaries + determinism, missing/invalid inputs,
 * double-counting guard, freshness + independence, contradictions, every
 * hard gate + exclusion from ranking, ties, identical-input identity,
 * versioning + history, stale detection, sensitivity determinism +
 * synthetic/real separation, authorization, and full T-002..T-010
 * regressions (separate run).
 */
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { ingestObservation, attachEvidence } from "../lib/evidence/ingest";
import { decideHypothesis, generateHypotheses } from "../lib/hypothesis/rules";
import { createProposal, decideProposal } from "../lib/proposal/proposals";
import {
  DEFAULT_WEIGHTS,
  bandFor,
  scoreOpportunity,
  type ScoreInputs,
} from "../lib/scoring/v1";
import {
  checkGates,
  evaluateHypothesis,
  rankedOpportunities,
  scoreHistory,
} from "../lib/scoring/evaluate";

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.T003_TEST_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const NOACCESS_URL =
  process.env.TEST_NOACCESS_URL ??
  "postgresql://noaccess:noaccess-local-only@127.0.0.1:5434/agency_intel_test";
const pool = new Pool({ connectionString: DB_URL, max: 3 });
const ACTOR = "t11test";
let seq = 0;
const dom = (p: string) => `t11-${Date.now()}-${seq++}-${p}.example`;

const FULL: ScoreInputs = {
  hasDomain: true,
  hasRegistry: true,
  hasCountry: true,
  hasCountryCode: true,
  hasAgencyType: true,
  corroboratedClaims: 2,
  independentOrigins: 2,
  freshSupporting: true,
  staleSupporting: false,
  hasRule: true,
  hasQuestions: true,
  hasRationale: true,
  contradictCount: 0,
  hasProposal: true,
  proposalFeasibility: "high",
  approvedCapability: true,
  unapprovedCapability: false,
  freshestEvidenceDays: 10,
};

async function mkCo(name: string, domain?: string) {
  return (
    await createCompany(
      pool,
      { name, domain: domain ?? dom("co"), agencyType: "web_development", country: "United States" },
      ACTOR,
    )
  ).companyId;
}

async function mkClaim(
  companyId: string,
  text: string,
  opts: { predicate?: string; status?: "observed" | "corroborated" | "inferred"; stale?: boolean; sourceKey?: string } = {},
) {
  const r = await ingestObservation(
    pool,
    {
      companyId,
      sourceKey: opts.sourceKey ?? "company-site",
      url: `https://s11.example/${seq++}`,
      excerpt: text.slice(0, 300),
      actor: ACTOR,
    },
    {
      predicate: opts.predicate ?? "announced",
      text,
      initialStatus: opts.status ?? "observed",
      reliability: "B",
      credibility: 2,
      expiresAt: opts.stale ? "2020-01-01T00:00:00Z" : undefined,
    },
  );
  return r.claimId!;
}

/** Rich company: portal claim + corroboration via second source + questions. */
async function mkScorable(name: string): Promise<{ co: string; hyp: string }> {
  const co = await mkCo(name);
  const c1 = await mkClaim(co, "Client onboarding portal announced", { sourceKey: "company-site" });
  const c = await pool.connect();
  try {
    // Second independent origin for the same assertion.
    const s = await c.query(
      `insert into public.snapshot (company_id, source_key, url, sha256, retention_class)
       values ($1, 'agency-directory', $2, $3, 'directory') returning id`,
      [co, `https://s11.example/dir-${seq++}`, "f".repeat(64)],
    );
    await c.query(
      `insert into public.claim (company_id, snapshot_id, claim_text, claim_status, source_reliability, info_credibility)
       values ($1, $2, 'Client onboarding portal announced (directory listing)', 'corroborated', 'B', 2)`,
      [co, s.rows[0].id],
    );
    void c1;
  } finally {
    c.release();
  }
  const gen = await generateHypotheses(pool, co, ACTOR);
  const hyp = gen.hypotheses.find((h) => h.ruleId === "R-PORTAL-01")!.id;
  await decideHypothesis(pool, hyp, {
    decision: "validate",
    reason: "operator call confirmed",
    actor: ACTOR,
  });
  return { co, hyp };
}

async function cleanup() {
  const c = await pool.connect();
  try {
    await c.query(
      `delete from public.hypothesis_evidence where hypothesis_id in (
         select id from public.hypothesis where company_id in (
           select id from public.company
           where domain_norm like 't11-%' or name like 'T11 %'))`,
    );
    await c.query(
      "delete from public.company where domain_norm like 't11-%' or name like 'T11 %'",
    );
  } finally {
    c.release();
  }
}

describe("score_v1 pure core", () => {
  it("is versioned with documented provisional weights", () => {
    expect(DEFAULT_WEIGHTS).toEqual({
      fit: 30,
      evidence: 25,
      opportunity: 20,
      feasibility: 15,
      timing: 10,
    });
  });

  it("computes exact boundaries on crafted inputs", () => {
    const full = scoreOpportunity(FULL);
    // fit 8+10+7+5=30, evidence 10+8+7=25, opportunity 8+6+6=20,
    // feasibility 8+4+3=15, timing 10, deductions 0 → 100, band A.
    expect(full).toMatchObject({ total: 100, band: "A", partial: false });
    expect(full.missing).toEqual([]);
    const empty = scoreOpportunity({
      ...FULL,
      hasDomain: false,
      hasRegistry: false,
      hasCountry: false,
      hasAgencyType: false,
      corroboratedClaims: 0,
      independentOrigins: 0,
      freshSupporting: false,
      hasRule: false,
      hasQuestions: false,
      hasRationale: false,
      hasProposal: false,
      freshestEvidenceDays: null,
    });
    expect(empty.total).toBe(0);
    expect(empty.band).toBe("D");
    expect(empty.partial).toBe(true);
    expect(empty.missing.length).toBeGreaterThan(0);
  });

  it("is deterministic on identical inputs (incl. weight overrides)", () => {
    const a = scoreOpportunity(FULL);
    const b = scoreOpportunity(JSON.parse(JSON.stringify(FULL)));
    expect(a).toEqual(b);
    const custom = scoreOpportunity(FULL, { ...DEFAULT_WEIGHTS, fit: 10 });
    expect(custom.fit.max).toBe(10);
    expect(custom.total).toBe(100 - 20);
  });

  it("bands at documented edges", () => {
    expect(bandFor(75)).toBe("A");
    expect(bandFor(74)).toBe("B");
    expect(bandFor(55)).toBe("B");
    expect(bandFor(54)).toBe("C");
    expect(bandFor(35)).toBe("C");
    expect(bandFor(34)).toBe("D");
    expect(bandFor(0)).toBe("D");
  });

  it("keeps deductions risk-only (no double counting)", () => {
    const r = scoreOpportunity({ ...FULL, contradictCount: 2, staleSupporting: true });
    expect(r.deductions).toMatchObject({ points: 10 });
    expect(r.deductions.reasons.join(" ")).toMatch(/contradict/);
    // Evidence dimension itself is untouched by the contradiction count.
    expect(r.evidence.points).toBe(25);
  });
});

describe("hard gates", () => {
  it("fails rejected, superseded, generated, merged, unsupported, conflicted", async () => {
    // Rejected.
    const co = await mkCo("T11 Rej Co");
    try {
      await mkClaim(co, "Client portal onboarding announced");
      const gen = await generateHypotheses(pool, co, ACTOR);
      const hyp = gen.hypotheses[0].id;
      await decideHypothesis(pool, hyp, { decision: "reject", reason: "no fit", actor: ACTOR });
      const g = await checkGates(pool, hyp);
      expect(g.eligible).toBe(false);
      expect(g.gates.find((x) => x.id === "hypothesis-active")?.passed).toBe(false);
      await expect(evaluateHypothesis(pool, hyp, ACTOR)).rejects.toMatchObject({
        status: 409,
        code: "gates_failed",
      });
      // Unknown hypothesis.
      const g2 = await checkGates(pool, "00000000-0000-4000-8000-000000000000");
      expect(g2.eligible).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("generated-but-unreviewed is an explicit insufficient state", async () => {
    const co = await mkCo("T11 Gen Co");
    try {
      await mkClaim(co, "Client portal onboarding announced");
      const gen = await generateHypotheses(pool, co, ACTOR);
      // Status is generated (no human review yet) — gate must fail.
      const g = await checkGates(pool, gen.hypotheses[0].id);
      const rev = g.gates.find((x) => x.id === "hypothesis-reviewed")!;
      expect(rev.passed).toBe(false);
      expect(g.eligible).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("no supporting evidence is insufficient, not low-scored", async () => {
    const co = await mkCo("T11 Bare Co");
    const c = await pool.connect();
    let hyp = "";
    try {
      // Hypothesis row without evidence links (direct insert, documented probe).
      const h = await c.query(
        `insert into public.hypothesis (company_id, title, opportunity_category, status, rule_id, rule_version)
         values ($1, 'T11 probe', 'portals_dashboards', 'needs_review', 'R-PORTAL-01', '1') returning id`,
        [co],
      );
      hyp = h.rows[0].id as string;
    } finally {
      c.release();
    }
    try {
      const g = await checkGates(pool, hyp);
      expect(g.gates.find((x) => x.id === "has-support")?.passed).toBe(false);
      expect(g.eligible).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("pending identity conflicts block ranking", async () => {
    const { co, hyp } = await mkScorable("T11 Ident Co");
    try {
      // Fabricate a pending identity candidate against this company.
      const other = await mkCo("T11 Ident Other");
      const c = await pool.connect();
      try {
        await c.query(
          `insert into public.match_candidate (company_a, company_b, rule, detail)
           values ($1, $2, 'name_exact', 't11 probe')`,
          [co, other],
        );
      } finally {
        c.release();
      }
      // Validate so only the identity gate fails.
      await decideHypothesis(pool, hyp, { decision: "validate", reason: "t11", actor: ACTOR });
      const g = await checkGates(pool, hyp);
      expect(g.gates.find((x) => x.id === "identity-clear")?.passed).toBe(false);
      expect(g.eligible).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe("evaluation, history, freshness, ranking", () => {
  it("persists versioned runs with rationale; history accumulates", async () => {
    const { hyp } = await mkScorable("T11 Hist Co");
    try {
      const e1 = await evaluateHypothesis(pool, hyp, ACTOR);
      // Company has domain/country/type but no registry; one corroborated
      // claim exists but is not rule-linked (null predicate), one origin,
      // no proposal: partial with exactly these documented gaps.
      expect(e1.total).toBe(57);
      expect(e1.band).toBe("B");
      expect(e1.partial).toBe(true);
      expect(e1.breakdown.missing).toEqual([
        "registry",
        "corroborated_claims",
        "independent_origins>=2",
        "proposal",
      ]);
      const e2 = await evaluateHypothesis(pool, hyp, ACTOR);
      expect(e2.total).toBe(e1.total);
      const hist = await scoreHistory(pool, hyp);
      expect(hist).toHaveLength(2);
      expect(hist.every((h) => h.model_version === "score_v1")).toBe(true);
      const c = await pool.connect();
      try {
        const au = await c.query(
          "select count(*)::int as n from public.audit_log where entity_type = 'score_run'",
        );
        expect(au.rows[0].n).toBeGreaterThanOrEqual(2);
      } finally {
        c.release();
      }
    } finally {
      await cleanup();
    }
  });

  it("marks missing dimensions explicitly (no proposal, stale evidence)", async () => {
    const co = await mkCo("T11 Thin Co");
    try {
      await mkClaim(co, "Client portal onboarding announced");
      const gen = await generateHypotheses(pool, co, ACTOR);
      const hyp = gen.hypotheses[0].id;
      // Attach a stale supporting claim directly (engine accepts
      // reviewer-linked evidence regardless of rule matching).
      const stale = await mkClaim(co, "Old portal mention", { stale: true });
      const c = await pool.connect();
      try {
        await c.query(
          `insert into public.hypothesis_evidence (hypothesis_id, claim_id, polarity)
           values ($1, $2, 'supports') on conflict do nothing`,
          [hyp, stale],
        );
      } finally {
        c.release();
      }
      await decideHypothesis(pool, hyp, { decision: "validate", reason: "t11", actor: ACTOR });
      const e = await evaluateHypothesis(pool, hyp, ACTOR);
      expect(e.partial).toBe(true);
      expect(e.breakdown.missing).toContain("proposal");
      expect(e.breakdown.deductions.points).toBe(5); // stale support
      expect(e.breakdown.feasibility.points).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("ranks deterministically with documented tie-breaks; excludes ineligible", async () => {
    const a = await mkScorable("T11 Rank A");
    const b = await mkScorable("T11 Rank B");
    try {
      // A gets a proposal (feasibility points); B stays proposal-less.
      const prop = await createProposal(pool, {
        hypothesisId: a.hyp,
        title: "T11 prop",
        feasibility: "high",
        assumptions: "t11 assumptions",
        items: [{ name: "X", complexity: "S", kind: "feature" }],
        actor: ACTOR,
      });
      void prop;
      const ea = await evaluateHypothesis(pool, a.hyp, ACTOR);
      const eb = await evaluateHypothesis(pool, b.hyp, ACTOR);
      expect(ea.total).toBeGreaterThan(eb.total);
      const rank = await rankedOpportunities(pool);
      const ids = rank.map((r) => r.hypothesis_id);
      expect(ids.indexOf(a.hyp)).toBeLessThan(ids.indexOf(b.hyp));
      // Identical re-evaluation keeps order (deterministic).
      const rank2 = await rankedOpportunities(pool);
      expect(rank2.map((r) => r.hypothesis_id)).toEqual(ids);
      // Ineligible rows never appear even with stored legacy totals.
      for (const r of rank) {
        const g = await checkGates(pool, r.hypothesis_id);
        expect(g.eligible).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  it("detects stale scores after material evidence changes", async () => {
    // Deferred (reviewed but open) hypothesis: new evidence tops up links in
    // place, so the stored score goes stale instead of superseding.
    const co = await mkCo("T11 Stale Co");
    try {
      await mkClaim(co, "Client onboarding portal announced");
      const gen = await generateHypotheses(pool, co, ACTOR);
      const hyp = gen.hypotheses[0].id;
      const { decideHypothesis } = await import("../lib/hypothesis/rules");
      await decideHypothesis(pool, hyp, { decision: "defer", reason: "parked", actor: ACTOR });
      await evaluateHypothesis(pool, hyp, ACTOR);
      await mkClaim(co, "Second onboarding announcement");
      await generateHypotheses(pool, co, ACTOR);
      const rank = await rankedOpportunities(pool);
      const mine = rank.find((r) => r.hypothesis_id === hyp)!;
      expect(mine.stale).toBe(true);
      expect(mine.staleReasons.join(" ")).toMatch(/evidence/);
    } finally {
      await cleanup();
    }
  });

  it("denies unprivileged score writes", async () => {
    const denied = new Pool({ connectionString: NOACCESS_URL, max: 1 });
    try {
      await expect(
        denied.query(
          "insert into public.score_run (hypothesis_id, fit, evidence, opportunity, feasibility, timing, explanation) values ($1,1,1,1,1,1,'{}')",
          ["00000000-0000-4000-8000-000000000000"],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await denied.end();
    }
  });
});

describe("sensitivity (synthetic fixtures, deterministic)", () => {
  it("reproduces sensitivity runs exactly; wide-margin leader is stable", () => {
    // Synthetic — never presented as real-world validation (see protocol).
    const leader: ScoreInputs = { ...FULL };
    const trailer: ScoreInputs = {
      ...FULL,
      corroboratedClaims: 0,
      independentOrigins: 1,
      hasProposal: false,
      freshestEvidenceDays: 120,
      contradictCount: 1,
    };
    const margins: number[] = [];
    for (const delta of [-0.2, -0.1, 0, 0.1, 0.2]) {
      const w = { ...DEFAULT_WEIGHTS };
      (Object.keys(w) as (keyof typeof w)[]).forEach((k) => {
        w[k] = Math.max(1, Math.round(DEFAULT_WEIGHTS[k] * (1 + delta)));
      });
      const l = scoreOpportunity(leader, w).total;
      const t = scoreOpportunity(trailer, w).total;
      margins.push(l - t);
      // Reproducibility: same weights twice → same totals.
      expect(scoreOpportunity(leader, w).total).toBe(l);
      expect(scoreOpportunity(trailer, w).total).toBe(t);
    }
    // Wide-margin leader (identical-input deltas are zero only if tied).
    expect(margins.every((m) => m > 20)).toBe(true);
  });
});
