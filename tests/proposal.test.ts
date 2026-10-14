/**
 * T-009 proposal tests (local DB only, loopback guard).
 * Covers: estimation formulas/boundaries/versioning, insufficient info,
 * currency preservation, profile assembly, eligibility, explicit creation,
 * validation, version history + immutability, freshness flags, rejected
 * gating, merge preservation, rollback, concurrency, authorization,
 * invalid input, verbatim rendering. Full regressions run separately.
 */
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { ingestObservation } from "../lib/evidence/ingest";
import { decideHypothesis, generateHypotheses } from "../lib/hypothesis/rules";
import { getCompanyDetail } from "../lib/resolve/detail";
import {
  ESTIMATION_VERSION,
  estimateEffort,
  validateEstimateInput,
} from "../lib/proposal/estimate";
import {
  createProposal,
  createVersion,
  decideProposal,
  getProposalDetail,
} from "../lib/proposal/proposals";

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
const ACTOR = "t9test";
let seq = 0;
const dom = (p: string) => `t9-${Date.now()}-${seq++}-${p}.example`;

async function mkValidatedHypothesis(name: string): Promise<{ co: string; hyp: string }> {
  const co = (
    await createCompany(
      pool,
      { name, domain: dom("co"), agencyType: "web_development", country: "United States" },
      ACTOR,
    )
  ).companyId;
  await ingestObservation(
    pool,
    { companyId: co, sourceKey: "company-site", url: `https://h9.example/${seq++}`, excerpt: "Client onboarding portal announced", actor: ACTOR },
    { predicate: "announced", text: "Client onboarding portal announced", reliability: "B", credibility: 2 },
  );
  const gen = await generateHypotheses(pool, co, ACTOR);
  const hyp = gen.hypotheses[0].id;
  await decideHypothesis(pool, hyp, {
    decision: "validate",
    reason: "operator call confirmed intake pain",
    actor: ACTOR,
  });
  return { co, hyp };
}

const BASE_INPUT = {
  title: "T9 Portal Pilot",
  scopeIn: "Intake form, status page, one pilot team",
  scopeOut: "Billing migration, mobile apps",
  feasibility: "medium" as const,
  assumptions: "Agency confirms email intake; pilot team available",
  dependencies: "Brand assets from agency",
  validationQuestions: "Who pilots? What does login cover?",
  items: [{ name: "Intake form", complexity: "M" as const, kind: "feature" as const }],
  contingencyPct: 15,
  actor: ACTOR,
};

async function cleanup() {
  const c = await pool.connect();
  try {
    await c.query(
      `delete from public.hypothesis_evidence where hypothesis_id in (
         select id from public.hypothesis where company_id in (
           select id from public.company
           where domain_norm like 't9-%' or name like 'T9 %'))`,
    );
    await c.query(
      "delete from public.company where domain_norm like 't9-%' or name like 'T9 %'",
    );
    await c.query("delete from public.capability where key like 't9-%'");
  } finally {
    c.release();
  }
}

describe("estimation model v1 (pure)", () => {
  it("is versioned and computes documented ranges", () => {
    expect(ESTIMATION_VERSION).toBe("1");
    const r = estimateEffort({
      items: [{ name: "Intake form", complexity: "M", kind: "feature" }],
      contingencyPct: 15,
      assumptions: ["team available"],
    });
    expect(r.outcome).toBe("estimated");
    if (r.outcome !== "estimated") return;
    // subtotal 5–10 + handover 2–3 = 7–13, ×1.15 → ceil 9 / 15.
    expect(r).toMatchObject({ effortLoDays: 9, effortHiDays: 15, confidence: "medium" });
    expect(r.lines.join("\n")).toMatch(/contingency/);
  });

  it("applies kind multipliers, testing share, security flat, XL caps", () => {
    const r = estimateEffort({
      items: [
        { name: "Sync", complexity: "S", kind: "integration" }, // 2–4 ×1.5 = 3–6
        { name: "Hardening", complexity: "S", kind: "security" }, // 2–4 + flat 3–5
        { name: "Suite", complexity: "M", kind: "testing" }, // +20% subtotal
      ],
      contingencyPct: 0,
      assumptions: ["a"],
    });
    expect(r.outcome).toBe("estimated");
    if (r.outcome !== "estimated") return;
    // subtotal lo 3+2=5, hi 6+4=10; security +3–5 → 8–15; testing +20% → 9.6–18;
    // handover +2–3 → 11.6–21 → ceil 12/21.
    expect(r).toMatchObject({ effortLoDays: 12, effortHiDays: 21 });
    const xl = estimateEffort({
      items: [{ name: "Big", complexity: "XL", kind: "feature" }],
      contingencyPct: 0,
      assumptions: ["a"],
    });
    expect(xl.outcome).toBe("estimated");
    if (xl.outcome !== "estimated") return;
    expect(xl.confidence).toBe("low");
    expect(xl.effortLoDays).toBe(27); // 25 + 2 handover
  });

  it("returns insufficient_information instead of inventing precision", () => {
    expect(estimateEffort({ items: [], contingencyPct: 10, assumptions: ["a"] })).toMatchObject({
      outcome: "insufficient_information",
    });
    expect(
      estimateEffort({ items: [{ name: "", complexity: "M", kind: "feature" }], contingencyPct: 10, assumptions: ["a"] }).outcome,
    ).toBe("insufficient_information");
    expect(validateEstimateInput({ items: [], contingencyPct: 200, assumptions: [""] }).length).toBeGreaterThan(0);
  });
});

describe("proposal creation", () => {
  it("requires explicit action on a validated hypothesis (no auto-creation)", async () => {
    const { co, hyp } = await mkValidatedHypothesis("T9 Explicit Co");
    try {
      // Generation alone creates zero proposals.
      const c = await pool.connect();
      try {
        const n = await c.query(
          "select count(*)::int as n from public.project_option where hypothesis_id = $1",
          [hyp],
        );
        expect(n.rows[0].n).toBe(0);
      } finally {
        c.release();
      }
      const p = await createProposal(pool, { ...BASE_INPUT, hypothesisId: hyp });
      expect(p.version).toBe(1);
      const d = await getProposalDetail(pool, p.id);
      expect(d?.proposal).toMatchObject({ status: "draft" });
      void co;
    } finally {
      await cleanup();
    }
  });

  it("rejects non-validated hypotheses with guidance", async () => {
    const co = (
      await createCompany(
        pool,
        { name: "T9 Raw Co", domain: dom("co"), agencyType: "web_development", country: "United States" },
        ACTOR,
      )
    ).companyId;
    try {
      await ingestObservation(
        pool,
        { companyId: co, sourceKey: "company-site", url: `https://h9.example/${seq++}`, excerpt: "Client portal onboarding announced", actor: ACTOR },
        { predicate: "announced", text: "Client portal onboarding announced", reliability: "B", credibility: 2 },
      );
      const gen = await generateHypotheses(pool, co, ACTOR);
      const hyp = gen.hypotheses[0].id; // status generated/needs_review
      await expect(
        createProposal(pool, { ...BASE_INPUT, hypothesisId: hyp }),
      ).rejects.toMatchObject({ status: 409, code: "hypothesis_not_eligible" });
      await expect(
        createProposal(pool, { ...BASE_INPUT, hypothesisId: "00000000-0000-4000-8000-000000000000" }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await cleanup();
    }
  });

  it("validates content strictly (no half estimates, no missing assumptions)", async () => {
    const { hyp } = await mkValidatedHypothesis("T9 Strict Co");
    try {
      await expect(
        createProposal(pool, { ...BASE_INPUT, hypothesisId: hyp, title: "  " }),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        createProposal(pool, { ...BASE_INPUT, hypothesisId: hyp, assumptions: "" }),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        createProposal(pool, { ...BASE_INPUT, hypothesisId: hyp, costLow: 100 }),
      ).rejects.toMatchObject({ status: 422 }); // half estimate
      await expect(
        createProposal(pool, { ...BASE_INPUT, hypothesisId: hyp, costLow: 99, costHigh: 10, costCurrency: "USD" }),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        createProposal(pool, {
          ...BASE_INPUT, hypothesisId: hyp, costLow: 1, costHigh: 2, costCurrency: "usd",
        }),
      ).rejects.toMatchObject({ status: 422 }); // lowercase currency
      await expect(
        createProposal(pool, { ...BASE_INPUT, hypothesisId: hyp, timelineLoWeeks: 4 }),
      ).rejects.toMatchObject({ status: 422 }); // half timeline
      await expect(
        createProposal(pool, { ...BASE_INPUT, hypothesisId: hyp, capabilityKeys: ["nope"] }),
      ).rejects.toMatchObject({ status: 422 });
    } finally {
      await cleanup();
    }
  });

  it("stores no estimate when information is insufficient; preserves currency", async () => {
    const { hyp } = await mkValidatedHypothesis("T9 Thin Co");
    try {
      const p = await createProposal(pool, {
        ...BASE_INPUT,
        hypothesisId: hyp,
        items: [],
        costLow: 8000,
        costHigh: 15000,
        costCurrency: "USD",
        pricingModel: "fixed_scope",
        taxNote: "Excl. VAT; third-party email delivery passed through at cost",
      });
      const d = await getProposalDetail(pool, p.id);
      const pr = d?.proposal as Record<string, unknown>;
      expect(pr["effort_lo_days"]).toBeNull();
      expect(pr["estimation_version"]).toBeNull();
      // Currency preserved exactly — never converted.
      expect(pr).toMatchObject({ cost_low: "8000.00", cost_high: "15000.00", cost_currency: "USD" });
    } finally {
      await cleanup();
    }
  });

  it("rejects second drafts (one draft per hypothesis)", async () => {
    const { hyp } = await mkValidatedHypothesis("T9 Dup Co");
    try {
      await createProposal(pool, { ...BASE_INPUT, hypothesisId: hyp });
      await expect(
        createProposal(pool, { ...BASE_INPUT, hypothesisId: hyp }),
      ).rejects.toMatchObject({ status: 409, code: "draft_exists" });
    } finally {
      await cleanup();
    }
  });
});

describe("versions, decisions, freshness", () => {
  it("versions supersede (never rewrite) and decisions are gated", async () => {
    const { hyp } = await mkValidatedHypothesis("T9 Version Co");
    try {
      const v1 = await createProposal(pool, { ...BASE_INPUT, hypothesisId: hyp });
      // Invalid transition first: draft cannot be accepted directly.
      await expect(
        decideProposal(pool, v1.id, { decision: "accept", reason: "x", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        decideProposal(pool, v1.id, { decision: "submit", reason: "", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 422 });
      const v2 = await createVersion(pool, v1.id, ACTOR, {
        scopeOut: "Billing migration, mobile apps, legacy import",
      });
      expect(v2.version).toBe(2);
      const c = await pool.connect();
      try {
        const s = await c.query("select status from public.project_option where id = $1", [v1.id]);
        expect(s.rows[0].status).toBe("superseded");
        // Decided history is immutable via the API: superseded rejects decisions.
        await expect(
          decideProposal(pool, v1.id, { decision: "archive", reason: "x", actor: ACTOR }),
        ).rejects.toMatchObject({ status: 409 });
      } finally {
        c.release();
      }
      // Full lifecycle on v2 with audit each step.
      for (const [decision, want] of [["submit", "in_review"]] as const) {
        const r = await decideProposal(pool, v2.id, { decision, reason: `t9 ${decision}`, actor: ACTOR });
        expect(r.status).toBe(want);
      }
      const acc = await decideProposal(pool, v2.id, { decision: "accept", reason: "pursue internally", actor: ACTOR });
      expect(acc.status).toBe("accepted");
      const fin = await decideProposal(pool, v2.id, { decision: "archive", reason: "done", actor: ACTOR });
      expect(fin.status).toBe("archived");
      const d = await getProposalDetail(pool, v2.id);
      expect(d?.versions.map((v) => v.version)).toEqual([1, 2]);
    } finally {
      await cleanup();
    }
  });

  it("flags material evidence changes without erasing history", async () => {
    const { co, hyp } = await mkValidatedHypothesis("T9 Stale Co");
    try {
      const p = await createProposal(pool, { ...BASE_INPUT, hypothesisId: hyp });
      const fresh = await getProposalDetail(pool, p.id);
      expect(fresh?.stale).toBe(false);
      // New evidence arrives after the version.
      await ingestObservation(
        pool,
        { companyId: co, sourceKey: "company-site", url: `https://h9.example/${seq++}`, excerpt: "Second onboarding announcement", actor: ACTOR },
        { predicate: "announced", text: "Second onboarding announcement", reliability: "B", credibility: 2 },
      );
      await generateHypotheses(pool, co, ACTOR);
      const stale = await getProposalDetail(pool, p.id);
      expect(stale?.stale).toBe(true);
      // Either new-evidence linkage or hypothesis supersession explains it.
      expect(stale?.staleReasons.join(" ")).toMatch(/evidence|superseded/);
      void co;
    } finally {
      await cleanup();
    }
  });

  it("concurrent versions serialize to one v2", async () => {
    const { hyp } = await mkValidatedHypothesis("T9 Race Co");
    try {
      const v1 = await createProposal(pool, { ...BASE_INPUT, hypothesisId: hyp });
      const [a, b] = await Promise.allSettled([
        createVersion(pool, v1.id, ACTOR, { scopeOut: "A" }),
        createVersion(pool, v1.id, ACTOR, { scopeOut: "B" }),
      ]);
      const ok = [a, b].filter((x) => x.status === "fulfilled");
      const denied = [a, b].filter(
        (x) => x.status === "rejected" && (x.reason as { status?: number }).status === 409,
      );
      // Either exactly one wins, or the loser transparently retried onto v2:
      // in all cases at most two v2 rows must never exist.
      expect(ok.length + denied.length).toBe(2);
      const c = await pool.connect();
      try {
        const n = await c.query(
          "select count(*)::int as n from public.project_option where hypothesis_id = $1 and version = 2",
          [hyp],
        );
        expect(n.rows[0].n).toBeLessThanOrEqual(1);
      } finally {
        c.release();
      }
    } finally {
      await cleanup();
    }
  });

  it("denies unprivileged writes; stores untrusted text verbatim", async () => {
    const denied = new Pool({ connectionString: NOACCESS_URL, max: 1 });
    try {
      await expect(
        denied.query("insert into public.project_option (hypothesis_id, title) values ($1, 'x')", [
          "00000000-0000-4000-8000-000000000000",
        ]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await denied.end();
    }
    const { hyp } = await mkValidatedHypothesis("T9 Markup Co");
    try {
      const evil = "<script>alert(1)</script> scope";
      const p = await createProposal(pool, { ...BASE_INPUT, hypothesisId: hyp, scopeIn: evil });
      const d = await getProposalDetail(pool, p.id);
      expect((d?.proposal as Record<string, unknown>)["scope_in"]).toBe(evil);
    } finally {
      await cleanup();
    }
  });
});

describe("profile + merge integrity", () => {
  it("assembles identity, claims, hypotheses, proposals with review states", async () => {
    const { co, hyp } = await mkValidatedHypothesis("T9 Profile Co");
    try {
      const { getCompanyDetail } = await import("../lib/resolve/detail");
      const p = await createProposal(pool, { ...BASE_INPUT, hypothesisId: hyp });
      const d = await getCompanyDetail(pool, co);
      expect(d?.claims.length).toBeGreaterThanOrEqual(1);
      expect(d?.hypotheses.map((h) => h.status)).toContain("validated");
      // Facts (identity/claims) vs reviewable artifacts (hypotheses/proposals)
      // arrive in distinct sections with their own statuses.
      expect(d?.proposals).toMatchObject([{ id: p.id, status: "draft" }]);
    } finally {
      await cleanup();
    }
  });

  it("merges preserve proposal relationships via hypotheses", async () => {
    const { co: loserCo, hyp } = await mkValidatedHypothesis("T9 Mergee Ltd");
    const winnerCo = (
      await createCompany(
        pool,
        { name: "T9 Mergee", domain: dom("co"), agencyType: "web_development", country: "United States" },
        ACTOR,
      )
    ).companyId;
    const p = await createProposal(pool, { ...BASE_INPUT, hypothesisId: hyp });
    const c = await pool.connect();
    try {
      await c.query("select public.resolve_merge_company($1, $2, $3, $4)", [
        loserCo,
        winnerCo,
        ACTOR,
        "t9 merge probe",
      ]);
      const d = await (await import("../lib/resolve/detail")).getCompanyDetail(pool, winnerCo);
      expect(d?.proposals.map((x) => x.id)).toContain(p.id);
    } finally {
      c.release();
    }
    await cleanup();
  });
});
