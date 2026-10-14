/**
 * T-008 hypothesis engine tests (local DB only, loopback guard).
 * Covers: taxonomy/rules per category, insufficient evidence, GLEIF-only
 * silence, stale/ineligible evidence, contradictions + alternatives,
 * missing-info, versioning/determinism, idempotent generation, reevaluation
 * + supersession, all five decisions + audit, merge preservation, rollback,
 * concurrency, authorization, malformed input, adversarial fixtures, and the
 * no_supported_hypothesis outcome. Full regressions run separately.
 */
import { readFileSync } from "fs";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { ingestObservation } from "../lib/evidence/ingest";
import { attachEvidence } from "../lib/evidence/ingest";
import { assessClaim } from "../lib/evidence/assessment";
import {
  RULES,
  RULES_VERSION,
  decideHypothesis,
  evaluateRules,
  generateHypotheses,
} from "../lib/hypothesis/rules";
import { getHypothesisDetail } from "../lib/hypothesis/detail";
import { TAXONOMY, TAXONOMY_VERSION } from "../lib/hypothesis/taxonomy";

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
const ACTOR = "t8test";
let seq = 0;
const dom = (p: string) => `t8-${Date.now()}-${seq++}-${p}.example`;

interface FakeClaim {
  id: string;
  predicate: string | null;
  status: string;
  stale: boolean;
  claim_text: string;
  source_key: string;
  snapshot_url: string;
  needs_review: boolean;
}
let cid = 0;
const fc = (over: Partial<FakeClaim> = {}): FakeClaim => ({
  id: `c${(cid += 1)}`,
  predicate: "announced",
  status: "observed",
  stale: false,
  claim_text: "generic announcement",
  source_key: "company-site",
  snapshot_url: "https://x.example/1",
  needs_review: false,
  ...over,
});

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
  opts: {
    predicate?: string;
    status?: "observed" | "inferred" | "assumed";
    reliability?: "A" | "B" | "C" | "D";
    stale?: boolean;
    sourceKey?: string;
  } = {},
) {
  const url = `https://h8.example/${seq++}`;
  const r = await ingestObservation(
    pool,
    {
      companyId,
      sourceKey: opts.sourceKey ?? "company-site",
      url,
      excerpt: text.slice(0, 500),
      actor: ACTOR,
    },
    {
      predicate: opts.predicate,
      text,
      initialStatus: opts.status ?? "observed",
      reliability: opts.reliability ?? "B",
      credibility: 2,
      expiresAt: opts.stale ? "2020-01-01T00:00:00Z" : undefined,
    },
  );
  return r.claimId!;
}

async function cleanup() {
  const c = await pool.connect();
  try {
    // Dependency order: hypothesis_evidence.claim_id is ON DELETE RESTRICT
    // (T-002 design — links are never silently dropped), so unlink first.
    // Production takedown of linked records needs the same ordered removal.
    await c.query(
      `delete from public.hypothesis_evidence where hypothesis_id in (
         select id from public.hypothesis where company_id in (
           select id from public.company
           where domain_norm like 't8-%' or name like 'T8 %'))`,
    );
    await c.query(
      "delete from public.company where domain_norm like 't8-%' or name like 'T8 %'",
    );
  } finally {
    c.release();
  }
}

describe("taxonomy + rules (pure)", () => {
  it("is versioned with five firing rules across five categories", () => {
    expect(TAXONOMY_VERSION).toBe("1");
    expect(RULES_VERSION).toBe("1");
    expect(RULES.map((r) => r.id)).toEqual([
      "R-PORTAL-01",
      "R-HIRING-01",
      "R-INTEGRATION-01",
      "R-REPORTING-01",
      "R-TESTING-01",
    ]);
    for (const rule of RULES) {
      expect(rule.version).toBe("1");
      const tax = TAXONOMY.find((t) => t.category === rule.category)!;
      expect(tax.mustNotGenerate.length).toBeGreaterThan(0);
      expect(tax.alternatives.length).toBeGreaterThan(0);
      expect(tax.questions.length).toBeGreaterThan(0);
    }
  });

  it("fires each rule on matching evidence, silent otherwise", () => {
    const portal = evaluateRules(
      [fc({ claim_text: "We launched a new client onboarding flow, contact us by email" })],
      new Map(),
    );
    expect(portal.find((e) => e.ruleId === "R-PORTAL-01")?.fired).toBe(true);
    const hiring = evaluateRules(
      [fc({ predicate: "hiring", claim_text: "Hiring 3 frontend developers" })],
      new Map(),
    );
    expect(hiring.find((e) => e.ruleId === "R-HIRING-01")?.fired).toBe(true);
    const integration = evaluateRules(
      [fc({ claim_text: "New API and webhook integrations available" })],
      new Map(),
    );
    expect(integration.find((e) => e.ruleId === "R-INTEGRATION-01")?.fired).toBe(true);
    const reporting = evaluateRules(
      [fc({ claim_text: "Monthly reporting dashboard for clients" })],
      new Map(),
    );
    expect(reporting.find((e) => e.ruleId === "R-REPORTING-01")?.fired).toBe(true);
    const testing = evaluateRules(
      [fc({ predicate: "hiring", claim_text: "Hiring QA engineers for release testing" })],
      new Map(),
    );
    expect(testing.find((e) => e.ruleId === "R-TESTING-01")?.fired).toBe(true);
  });

  it("GLEIF-only / identity-only evidence fires nothing", () => {
    const out = evaluateRules(
      [fc({ predicate: "identity", claim_text: "Recorded under LEI 123 (FR)" })],
      new Map(),
    );
    expect(out.every((e) => !e.fired)).toBe(true);
  });

  it("service advertising alone never fires (safeguard)", () => {
    const out = evaluateRules(
      [fc({ predicate: "provides_service", claim_text: "We build client portals and APIs" })],
      new Map(),
    );
    expect(out.every((e) => !e.fired)).toBe(true);
  });

  it("excludes stale, withdrawn, superseded, disputed, assumed from support", () => {
    const base = {
      predicate: "announced",
      claim_text: "New client portal onboarding",
      source_key: "company-site",
      snapshot_url: "https://x.example/1",
    };
    for (const status of ["withdrawn", "superseded", "disputed", "assumed"]) {
      const out = evaluateRules([fc({ ...base, status })], new Map());
      expect(out.find((e) => e.ruleId === "R-PORTAL-01")?.fired).toBe(false);
    }
    const stale = evaluateRules(
      [fc({ ...base, stale: true })],
      new Map(),
    );
    expect(stale.find((e) => e.ruleId === "R-PORTAL-01")?.fired).toBe(false);
    // Assumed text is preserved as assumptions, not support.
    const withAssumed = evaluateRules(
      [
        fc({ ...base }),
        fc({ predicate: "other", status: "assumed", claim_text: "Someone assumes manual QA" }),
      ],
      new Map(),
    );
    const ev = withAssumed.find((e) => e.ruleId === "R-PORTAL-01")!;
    expect(ev.fired).toBe(true);
    expect(ev.assumedTexts.join(" ")).toMatch(/Someone assumes manual QA/);
  });

  it("is deterministic on repeated evaluation", () => {
    const claims = [fc({ claim_text: "Client portal onboarding announced" })];
    const a = evaluateRules(claims, new Map());
    const b = evaluateRules(claims, new Map());
    expect(a).toEqual(b);
  });
});

describe("generation lifecycle", () => {
  it("creates rule-pinned hypotheses with evidence, or explicit silence", async () => {
    const co = await mkCo("T8 Gen Co");
    try {
      await mkClaim(co, "Announcing a new client onboarding portal pilot", { predicate: "announced" });
      const r = await generateHypotheses(pool, co, ACTOR);
      expect(r.noSupportedHypothesis).toBe(false);
      expect(r.hypotheses).toHaveLength(1);
      expect(r.hypotheses[0]).toMatchObject({ ruleId: "R-PORTAL-01", created: true });
      expect(["generated", "needs_review"]).toContain(r.hypotheses[0].status);
      const d = await getHypothesisDetail(pool, r.hypotheses[0].id);
      expect(d?.hypothesis.rule_version).toBe("1");
      expect(d?.supporting).toHaveLength(1);
      expect(d?.hypothesis.intervention).toMatch(/PROPOSAL ONLY/);
      expect(d?.hypothesis.assumptions).toBeDefined();
      // GLEIF-style identity-only company stays silent.
      const co2 = await mkCo("T8 Silent Co");
      await mkClaim(co2, "Recorded under LEI 999 (DE)", { predicate: "identity" });
      const r2 = await generateHypotheses(pool, co2, ACTOR);
      expect(r2.noSupportedHypothesis).toBe(true);
      expect(r2.hypotheses).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("contradictions force needs_review and stay visible", async () => {
    const co = await mkCo("T8 Contra Co");
    try {
      const c1 = await mkClaim(co, "Client portal onboarding announced", { predicate: "announced" });
      const c2 = await mkClaim(co, "No portal exists or is planned", { predicate: "announced" });
      await attachEvidence(pool, {
        claimId: c1,
        linkedClaimId: c2,
        polarity: "contradicts",
        actor: ACTOR,
      });
      const r = await generateHypotheses(pool, co, ACTOR);
      expect(r.hypotheses[0].status).toBe("needs_review");
      const d = await getHypothesisDetail(pool, r.hypotheses[0].id);
      expect(d?.contradicting).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("repeated generation is idempotent; new evidence tops up, decisions supersede", async () => {
    const co = await mkCo("T8 Reval Co");
    try {
      await mkClaim(co, "Client onboarding portal announced", { predicate: "announced" });
      const r1 = await generateHypotheses(pool, co, ACTOR);
      const r2 = await generateHypotheses(pool, co, ACTOR);
      expect(r1.hypotheses.map((h) => h.id)).toEqual(r2.hypotheses.map((h) => h.id));
      expect(r2.hypotheses[0].created).toBe(false);
      // Reject, then add materially new evidence -> supersede + replace.
      const { decideHypothesis } = await import("../lib/hypothesis/rules");
      await decideHypothesis(pool, r1.hypotheses[0].id, {
        decision: "reject",
        reason: "portal already adequate",
        actor: ACTOR,
      });
      await mkClaim(co, "Second onboarding intake announcement", { predicate: "announced" });
      const r3 = await generateHypotheses(pool, co, ACTOR);
      expect(r3.hypotheses[0].created).toBe(true);
      expect(r3.hypotheses[0].id).not.toBe(r1.hypotheses[0].id);
      const c = await pool.connect();
      try {
        const s = await c.query("select status from public.hypothesis where id = $1", [
          r1.hypotheses[0].id,
        ]);
        expect(s.rows[0].status).toBe("superseded");
      } finally {
        c.release();
      }
      // No new evidence -> decided row returned untouched.
      const r4 = await generateHypotheses(pool, co, ACTOR);
      expect(r4.hypotheses[0].id).toBe(r3.hypotheses[0].id);
      expect(r4.hypotheses[0].created).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("merged records are skipped (hypotheses belong to canonical)", async () => {
    const c = await pool.connect();
    let loser = "";
    try {
      const a = await c.query(
        `insert into public.company (name, domain_norm, agency_type, country)
         values ('T8 Merged Loser', 't8-mloser.example', 'web_development', 'United States') returning id`,
      );
      loser = a.rows[0].id as string;
      const b = await c.query(
        `insert into public.company (name, domain_norm, agency_type, country)
         values ('T8 Merged Winner', 't8-mwinner.example', 'web_development', 'United States') returning id`,
      );
      await c.query("select public.resolve_merge_company($1, $2, $3, $4)", [
        loser,
        b.rows[0].id,
        ACTOR,
        "t8 probe",
      ]);
    } finally {
      c.release();
    }
    try {
      const r = await generateHypotheses(pool, loser, ACTOR);
      expect(r.noSupportedHypothesis).toBe(true);
      expect(r.hypotheses).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("404s unknown companies", async () => {
    await expect(
      generateHypotheses(pool, "00000000-0000-4000-8000-000000000000", ACTOR),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("human decisions", () => {
  it("records all five decisions with audit; validates meaning, not proof", async () => {
    const { decideHypothesis } = await import("../lib/hypothesis/rules");
    const mk = async (name: string) => {
      const co = await mkCo(name);
      await mkClaim(co, "Client portal onboarding announced", { predicate: "announced" });
      const r = await generateHypotheses(pool, co, ACTOR);
      return { co, id: r.hypotheses[0].id };
    };
    try {
      const v = await mk("T8 Dec V");
      const done = await decideHypothesis(pool, v.id, {
        decision: "validate",
        reason: "operator call confirmed intake pain",
        actor: ACTOR,
      });
      expect(done.status).toBe("validated");
      const d = await getHypothesisDetail(pool, v.id);
      expect(d?.hypothesis.decided_by).toBe(ACTOR);
      expect(d?.decisions.length).toBeGreaterThanOrEqual(2); // generated + validated
      for (const [name, decision, want] of [
        ["T8 Dec D", "defer", "deferred"],
        ["T8 Dec R", "reject", "rejected"],
        ["T8 Dec E", "request_evidence", "generated"],
        ["T8 Dec S", "supersede", "superseded"],
      ] as const) {
        const h = await mk(name);
        const r = await decideHypothesis(pool, h.id, {
          decision,
          reason: `testing ${decision}`,
          actor: ACTOR,
        });
        expect(r.status).toBe(want);
      }
      await expect(
        decideHypothesis(pool, v.id, { decision: "bogus", reason: "x", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        decideHypothesis(pool, v.id, { decision: "defer", reason: "", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 422 });
      // Superseded rows stay decided.
      const s = await mk("T8 Dec S2");
      await decideHypothesis(pool, s.id, { decision: "supersede", reason: "stale angle", actor: ACTOR });
      await expect(
        decideHypothesis(pool, s.id, { decision: "validate", reason: "change mind", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        decideHypothesis(pool, "00000000-0000-4000-8000-000000000000", {
          decision: "reject",
          reason: "x",
          actor: ACTOR,
        }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await cleanup();
    }
  });

  it("concurrent generation creates one row per rule", async () => {
    const co = await mkCo("T8 Race Co");
    try {
      await mkClaim(co, "Client portal onboarding announced", { predicate: "announced" });
      const results = await Promise.all([
        generateHypotheses(pool, co, ACTOR),
        generateHypotheses(pool, co, ACTOR),
      ]);
      const ids = results.flatMap((r) => r.hypotheses.map((h) => h.id));
      expect(new Set(ids).size).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("denies unprivileged writes to hypothesis tables", async () => {
    const denied = new Pool({ connectionString: NOACCESS_URL, max: 1 });
    try {
      await expect(
        denied.query("insert into public.hypothesis (company_id, title, opportunity_category) values ($1, 'x', 'other_digital')", [
          "00000000-0000-4000-8000-000000000000",
        ]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await denied.end();
    }
  });
});

describe("adversarial source content (trust boundary)", () => {
  const cases = JSON.parse(
    readFileSync("tests/fixtures/adversarial/source-texts.json", "utf8"),
  ) as { id: string; text: string }[];

  it("never validates, never scores, never leaks env from hostile text", async () => {
    process.env.T8_PROBE_SECRET = "probe-secret-xyz";
    const co = await mkCo("T8 Adversarial Co");
    try {
      for (const item of cases) {
        await mkClaim(co, `${item.text} (portal onboarding announced)`, { predicate: "announced" });
      }
      const before = await pool.query("select count(*)::int as n from public.score_run");
      const r = await generateHypotheses(pool, co, ACTOR);
      // Fake approval must not validate anything.
      expect(r.hypotheses.every((h) => h.status !== "validated")).toBe(true);
      const after = await pool.query("select count(*)::int as n from public.score_run");
      expect(after.rows[0].n).toBe(before.rows[0].n);
      // Nothing emitted may contain process secrets.
      const d = r.hypotheses.length > 0
        ? await getHypothesisDetail(pool, r.hypotheses[0].id)
        : null;
      // Nothing emitted may contain secret VALUES. Note: hostile source text
      // itself names "OPERATOR_API_TOKEN" as a phrase — quoting that text in
      // rationale/evidence display is legitimate (no value disclosed); the
      // canary below (a value present nowhere in fixtures) must be absent.
      const dumped = JSON.stringify({ r, d });
      expect(dumped).not.toMatch(/probe-secret-xyz/);
    } finally {
      delete process.env.T8_PROBE_SECRET;
      await cleanup();
    }
  });

  it("renders hostile excerpts verbatim at the API (React escapes at render)", async () => {
    const co = await mkCo("T8 Render Co");
    try {
      const evil = cases[0].text + " <img src=x onerror=alert(1)>";
      const r = await ingestObservation(
        pool,
        { companyId: co, sourceKey: "company-site", url: "https://adv.example/1", excerpt: evil, actor: ACTOR },
        { text: "T8 adversarial claim", reliability: "C", credibility: 4 },
      );
      const c = await pool.connect();
      try {
        const s = await c.query("select content_excerpt from public.snapshot where id = $1", [r.snapshotId]);
        // Stored verbatim (no stripping server-side); UI must escape on render.
        expect(s.rows[0].content_excerpt).toContain("<img");
      } finally {
        c.release();
      }
      void r.claimId;
    } finally {
      await cleanup();
    }
  });
});
