/**
 * Part 2 §7: deterministic lead-quality scoring.
 *
 * Proven: every dimension scores from available approved evidence with cited
 * references; missing data yields null (never a favourable default) and can
 * veto the composite via coverage; weight scaling leaves the composite
 * invariant; identical inputs replay byte-identically; more supporting
 * evidence never lowers need/evidence scores (monotonicity); capacity moves
 * pursuit only and never an intrinsic dimension; bands come from the policy
 * or not at all; timing decays by family rules against explicit as_of;
 * outputs contain no probability language (scores are ordinal ranks).
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidenceBundle } from "../lib/qualification/evidence";
import { readQualificationRow, type QualificationRow } from "../lib/qualification/view";
import { decayScore, score, type ScoreInput } from "../lib/qualification/scoring";
import { registerOpportunity } from "../lib/discovery/opportunities";
import {
  ACTOR,
  cleanupFixtures,
  fixturePolicy,
  fixtureService,
  fixtureRubric,
  fixtureCapacity,
  registerFixtureSet,
  seedCompanyWithClaims,
} from "./qualification_fixtures";
import type { PolicyDefinition } from "../lib/qualification/policy";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 4 });
const AS_OF = "2026-10-15T00:00:00.000Z";

let SET!: Awaited<ReturnType<typeof registerFixtureSet>>;

async function seedOpp(companyId: string, tag: string): Promise<string> {
  const stamp = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const o = await registerOpportunity(pool, {
    pipeline: "agency_partner",
    sourceKey: "company-site",
    sourceRecordId: `P2T-S-${stamp}`,
    companyId,
    actor: ACTOR,
  });
  return o.id;
}

async function scoreCompany(
  companyId: string,
  opportunityId: string,
  over: Partial<ScoreInput> = {},
): Promise<ReturnType<typeof score>> {
  const row = (await readQualificationRow(pool, opportunityId)) as QualificationRow;
  const bundle = await buildEvidenceBundle(pool, companyId, {
    asOf: AS_OF,
    signalMap: (over.policy ?? SET.policy).signalMap,
    freshnessDefaultDays: (over.policy ?? SET.policy).freshnessDefaultDays,
  });
  return score({
    row,
    bundle,
    policy: SET.policy,
    policyVersion: SET.policyVersion,
    services: [SET.service],
    catalogVersion: SET.catalogVersion,
    rubric: SET.rubric as ScoreInput["rubric"],
    rubricVersion: SET.rubricVersion,
    capacity: { version: SET.capacityVersion, definition: SET.capacity },
    operatorAnswers: {},
    asOf: AS_OF,
    requiredUsable: 1,
    ...over,
  });
}

beforeAll(async () => {
  await cleanupFixtures(pool);
  SET = await registerFixtureSet(pool, "score");
});
afterAll(async () => {
  await cleanupFixtures(pool);
  await pool.end();
});

describe("P2-score: dimensions score from available evidence", () => {
  it("a well-evidenced opportunity scores every dimension with references", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "rich", [
        { text: "Intake runs on email threads", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10, link: "supports" },
        { text: "Directory confirms forty staff", sourceKey: "agency-directory", predicate: "need-mobile", observedDaysAgo: 20, link: "supports" },
      ]);
      const oid = await seedOpp(s.companyId, "rich");
      const r = await scoreCompany(s.companyId, oid, {
        operatorAnswers: { contactChannelKnown: true, timelineMonths: 3 },
      });
      expect(r.outcome).toBe("eligible_for_assessment");
      for (const d of ["service_fit", "need_strength", "timing", "evidence_confidence", "actionability"] as const) {
        expect(r.dimensions[d].score, d).not.toBeNull();
        expect(r.dimensions[d].score).toBeGreaterThanOrEqual(0);
        expect(r.dimensions[d].score).toBeLessThanOrEqual(100);
      }
      expect(r.dimensions.service_fit.explanation).toMatch(/portal-build/);
      expect(r.dimensions.need_strength.evidenceRefs).toHaveLength(2);
      expect(r.composite).not.toBeNull();
      // Band follows the policy table, whatever it yields — derived here
      // from the same definition, never hardcoded.
      const expectedBand =
        SET.policy.bands === null
          ? null
          : (SET.policy.bands.find((b) => (r.composite as number) >= b.min)?.name ?? null);
      expect(r.band).toBe(expectedBand);
      expect(r.weightCoverage).toBe(1);
      expect(r.versions).toMatchObject({
        policy: SET.policyVersion,
        catalog: SET.catalogVersion,
        rubric: SET.rubricVersion,
        capacity: SET.capacityVersion,
      });
      expect(r.asOf).toBe(AS_OF);
      expect(r.engineVersion).toBeTruthy();
      expect(r.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.inputHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "score");
    }
  });

  it("missing data yields null dimensions and can veto the composite", async () => {
    try {
      // No usable evidence at all (unapproved source only). Evidence-driven
      // dimensions are null — but actionability still scores 40 from the one
      // available fact (the canonical domain exists). That partial score is
      // computed, not defaulted, and coverage (0.15 < 0.5) vetoes the
      // composite anyway.
      const s = await seedCompanyWithClaims(pool, "empty", [
        { text: "Unapproved whisper", sourceKey: "x-platform", observedDaysAgo: 5 },
      ]);
      const oid = await seedOpp(s.companyId, "empty");
      const r = await scoreCompany(s.companyId, oid);
      expect(r.outcome).toBe("needs_evidence");
      expect(r.dimensions.service_fit.score).toBeNull();
      expect(r.dimensions.need_strength.score).toBeNull();
      expect(r.dimensions.evidence_confidence.score).toBeNull();
      expect(r.dimensions.actionability.score).toBe(40);
      expect(r.composite).toBeNull();
      expect(r.weightCoverage).toBeCloseTo(0.15, 5);
      expect(r.flags).toContain("INSUFFICIENT_COVERAGE");
      expect(r.flags).toContain("NO_COMPOSITE");
      expect(r.band).toBeNull();
      // Missing is reported, never filled: evidence dimensions got no value.
      expect(r.missingData.length).toBeGreaterThan(0);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "score");
    }
  });

  it("a disqualifying anti-signal zeroes fit with an explicit flag", async () => {
    try {
      // 'has-portal' maps to the 'present_confirmed' family, which the
      // service lists as a disqualifying anti-signal: usable evidence in
      // that family zeroes service_fit for the service (dimension weakness
      // with a flag — the gate only checks that a compatible service exists).
      const s = await seedCompanyWithClaims(pool, "anti", [
        { text: "Need portals badly", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 5 },
        { text: "Client portal live since 2024", sourceKey: "company-site", predicate: "has-portal", observedDaysAgo: 5 },
      ]);
      const oid = await seedOpp(s.companyId, "anti");
      const svc = fixtureService({
        signalFamilies: ["need", "present_confirmed"],
        antiSignals: [{ id: "present_confirmed", description: "already operates a client portal", disqualifying: true }],
      });
      const policy = { ...SET.policy, signalMap: { ...SET.policy.signalMap, "has-portal": "present_confirmed" } };
      const row = (await readQualificationRow(pool, oid)) as QualificationRow;
      const { buildEvidenceBundle: beb } = await import("../lib/qualification/evidence");
      const bundle = await beb(pool, s.companyId, {
        asOf: AS_OF,
        signalMap: policy.signalMap,
        freshnessDefaultDays: 90,
      });
      const { score: sc } = await import("../lib/qualification/scoring");
      const r = sc({
        row,
        bundle,
        policy,
        policyVersion: SET.policyVersion,
        services: [svc],
        catalogVersion: SET.catalogVersion,
        rubric: SET.rubric as never,
        rubricVersion: SET.rubricVersion,
        capacity: null,
        operatorAnswers: {},
        asOf: AS_OF,
        requiredUsable: 1,
      });
      expect(r.dimensions.service_fit.score).toBe(0);
      expect(r.dimensions.service_fit.flags).toContain("ANTI_SIGNAL_HIT");
      expect(r.dimensions.service_fit.explanation).toMatch(/present_confirmed/);
      // Without the anti-signal evidence the same service scores positively.
      const clean = await seedCompanyWithClaims(pool, "antino", [
        { text: "Need portals badly", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 5 },
      ]);
      const oid2 = await seedOpp(clean.companyId, "antino");
      const r2 = await scoreCompany(clean.companyId, oid2, { services: [svc], policy });
      expect(r2.dimensions.service_fit.score).toBeGreaterThan(0);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "score");
    }
  });
});

describe("P2-score: mathematical properties", () => {
  it("weight scaling leaves the composite invariant", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "scale", [
        { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10, link: "supports" },
        { text: "Directory confirms size", sourceKey: "agency-directory", observedDaysAgo: 20 },
      ]);
      const oid = await seedOpp(s.companyId, "scale");
      const base = await scoreCompany(s.companyId, oid);
      const doubled: PolicyDefinition = {
        ...SET.policy,
        weights: Object.fromEntries(Object.entries(SET.policy.weights).map(([k, v]) => [k, v * 2])),
      };
      const scaled = await scoreCompany(s.companyId, oid, { policy: doubled });
      expect(scaled.composite).toBe(base.composite);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "score");
    }
  });

  it("identical inputs replay byte-identically", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "replay", [
        { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10, link: "supports" },
      ]);
      const oid = await seedOpp(s.companyId, "replay");
      const a = await scoreCompany(s.companyId, oid);
      const b = await scoreCompany(s.companyId, oid);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(b.inputHash).toBe(a.inputHash);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "score");
    }
  });

  it("more supporting evidence never lowers need or confidence (monotonicity)", async () => {
    try {
      const one = await seedCompanyWithClaims(pool, "mono1", [
        { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10, link: "supports" },
      ]);
      const oid1 = await seedOpp(one.companyId, "mono1");
      const r1 = await scoreCompany(one.companyId, oid1);
      const two = await seedCompanyWithClaims(pool, "mono2", [
        { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10, link: "supports" },
        { text: "Intake runs on email", sourceKey: "agency-directory", predicate: "need-portal", observedDaysAgo: 12, link: "supports" },
      ]);
      const oid2 = await seedOpp(two.companyId, "mono2");
      const r2 = await scoreCompany(two.companyId, oid2);
      expect(r2.dimensions.need_strength.score as number).toBeGreaterThanOrEqual(
        r1.dimensions.need_strength.score as number,
      );
      expect(r2.dimensions.evidence_confidence.score as number).toBeGreaterThanOrEqual(
        r1.dimensions.evidence_confidence.score as number,
      );
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "score");
    }
  });

  it("capacity moves pursuit only, never an intrinsic dimension", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "cap", [
        { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10, link: "supports" },
        { text: "Directory confirms size", sourceKey: "agency-directory", observedDaysAgo: 20 },
      ]);
      const oid = await seedOpp(s.companyId, "cap");
      const withCap = await scoreCompany(s.companyId, oid);
      const noCap = await scoreCompany(s.companyId, oid, { capacity: null });
      for (const d of ["service_fit", "need_strength", "timing", "evidence_confidence", "actionability"] as const) {
        expect(noCap.dimensions[d].score).toBe(withCap.dimensions[d].score);
      }
      expect(noCap.composite).toBe(withCap.composite);
      // Pursuit may differ (capacity alignment is order-only input)...
      expect(withCap.dimensions.pursuit_priority.flags).toContain("CAPACITY_ADJUSTED");
      expect(noCap.dimensions.pursuit_priority.flags).toContain("NO_CAPACITY");
      // ...and without capacity it equals the composite exactly.
      expect(noCap.dimensions.pursuit_priority.score).toBe(noCap.composite);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "score");
    }
  });

  it("bands come from the policy or not at all", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "band", [
        { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10, link: "supports" },
        { text: "Directory confirms size", sourceKey: "agency-directory", observedDaysAgo: 20 },
      ]);
      const oid = await seedOpp(s.companyId, "band");
      const nobands = await scoreCompany(s.companyId, oid, {
        policy: { ...SET.policy, bands: null },
      });
      expect(nobands.band).toBeNull();
      expect(nobands.flags).toContain("BANDS_NOT_PERMITTED");
      expect(nobands.composite).not.toBeNull(); // bands gate labels, not ranking
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "score");
    }
  });

  it("timing decays by family rules against explicit as_of", async () => {
    expect(decayScore(5, 30, 180)).toBe(100);
    expect(decayScore(30, 30, 180)).toBe(100);
    expect(decayScore(180, 30, 180)).toBe(20);
    expect(decayScore(500, 30, 180)).toBe(10);
    expect(decayScore(null, 30, 180)).toBe(50);
    try {
      const fresh = await seedCompanyWithClaims(pool, "timef", [
        { text: "Hiring portal engineers", sourceKey: "hiring-platform", predicate: "timing-hire", observedDaysAgo: 5 },
      ]);
      const stale = await seedCompanyWithClaims(pool, "times", [
        { text: "Hiring portal engineers", sourceKey: "hiring-platform", predicate: "timing-hire", observedDaysAgo: 100 },
      ]);
      const of = await seedOpp(fresh.companyId, "timef");
      const os = await seedOpp(stale.companyId, "times");
      const rf = await scoreCompany(fresh.companyId, of);
      const rs = await scoreCompany(stale.companyId, os);
      expect(rf.dimensions.timing.score as number).toBeGreaterThan(rs.dimensions.timing.score as number);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "score");
    }
  });

  it("outputs contain no probability language", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "prob", [
        { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10, link: "supports" },
      ]);
      const oid = await seedOpp(s.companyId, "prob");
      const r = await scoreCompany(s.companyId, oid);
      const text = JSON.stringify(r).toLowerCase();
      for (const word of ["probability", "likely to convert", "conversion rate", "expected value", "% chance"]) {
        expect(text, `score output must not claim '${word}'`).not.toContain(word);
      }
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "score");
    }
  });
});
