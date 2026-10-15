/**
 * Part 2 §10: immutable assessments and data integrity.
 *
 * Proven end-to-end with fixture versions: one operator run preserves the
 * snapshot, evaluates gates, scores permitted dimensions, stores the
 * assessment with every cited version + as_of + snapshot hash, and proposes
 * research. Same idempotency key + same request replays the recorded row;
 * same key + different request is a 409; a re-run appends a new version
 * (never overwrites); staleness reports the exact change (evidence moved,
 * version retired, suppression appeared, opportunity gone); inactive
 * references refuse the run before any write.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { transitionOpportunity } from "../lib/discovery/opportunities";
import { registerOpportunity } from "../lib/discovery/opportunities";
import { assessmentStaleness, runAssessment } from "../lib/qualification/assessments";
import {
  ACTOR,
  cleanupFixtures,
  registerFixtureSet,
  seedCompanyWithClaims,
} from "./qualification_fixtures";

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
    sourceRecordId: `P2T-A-${stamp}`,
    companyId,
    actor: ACTOR,
  });
  return o.id;
}

function runInput(opportunityId: string, over: Record<string, unknown> = {}) {
  return {
    opportunityId,
    policyVersion: SET.policyVersion,
    catalogVersion: SET.catalogVersion,
    rubricVersion: SET.rubricVersion,
    capacityVersion: SET.capacityVersion,
    operatorAnswers: {},
    asOf: AS_OF,
    actor: ACTOR,
    ...over,
  };
}

beforeAll(async () => {
  await cleanupFixtures(pool);
  SET = await registerFixtureSet(pool, "assess");
});
afterAll(async () => {
  await cleanupFixtures(pool);
  await pool.end();
});

describe("P2-assess: one run preserves, evaluates, scores and stores", () => {
  it("records an immutable assessment with every cited version", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "assess", [
        { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10, link: "supports" },
        { text: "Directory confirms size", sourceKey: "agency-directory", observedDaysAgo: 20 },
      ]);
      const oid = await seedOpp(s.companyId, "assess");
      const r = await runAssessment(pool, runInput(oid, { idempotencyKey: `p2t-a1-${Date.now()}` }));
      expect(r.version).toBe(1);
      expect(r.outcome).toBe("eligible_for_assessment");
      expect(r.composite).not.toBeNull();
      expect(r.replayed).toBe(false);
      const stored = await pool.query(
        `select policy_version, service_catalog_version, rubric_version, capacity_version,
                as_of, snapshot_hash, code_version, input_snapshot_id, decided_by
         from p2.case_assessment where assessment_id = $1`,
        [r.assessmentId],
      );
      expect(stored.rows[0]).toMatchObject({
        policy_version: SET.policyVersion,
        service_catalog_version: SET.catalogVersion,
        rubric_version: SET.rubricVersion,
        capacity_version: SET.capacityVersion,
        decided_by: ACTOR,
      });
      expect(stored.rows[0].snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.rows[0].code_version).toBeTruthy();
      // The assessment JSON carries dimensions, reasons and ranking output.
      const body = await pool.query("select assessment from p2.case_assessment where assessment_id = $1", [
        r.assessmentId,
      ]);
      expect(body.rows[0].assessment.dimensions.service_fit.score).not.toBeNull();
      expect(body.rows[0].assessment.inputHash).toMatch(/^[0-9a-f]{64}$/);
      // Research was proposed for the remaining blind spots.
      const tasks = await pool.query("select count(*)::int as n from p2.research_task where case_id = $1", [r.caseId]);
      expect(tasks.rows[0].n).toBeGreaterThan(0);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "assess");
    }
  });

  it("same key replays; same key with a different request conflicts", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "idem", [
        { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10 },
      ]);
      const oid = await seedOpp(s.companyId, "idem");
      const key = `p2t-a2-${Date.now()}`;
      const first = await runAssessment(pool, runInput(oid, { idempotencyKey: key }));
      const second = await runAssessment(pool, runInput(oid, { idempotencyKey: key }));
      expect(second.replayed).toBe(true);
      expect(second.assessmentId).toBe(first.assessmentId);
      expect(second.version).toBe(first.version);
      // Same key, different as_of = a different request: refused, no new row.
      await expect(
        runAssessment(pool, runInput(oid, { idempotencyKey: key, asOf: "2026-10-16T00:00:00.000Z" })),
      ).rejects.toMatchObject({ code: "idempotency_key_reuse" });
      const count = await pool.query(
        "select count(*)::int as n from p2.case_assessment where case_id = $1",
        [first.caseId],
      );
      expect(count.rows[0].n).toBe(1);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "assess");
    }
  });

  it("a re-run appends a new version; history is never overwritten", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "vers", [
        { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10 },
      ]);
      const oid = await seedOpp(s.companyId, "vers");
      const v1 = await runAssessment(pool, runInput(oid));
      const v2 = await runAssessment(pool, runInput(oid));
      expect(v2.version).toBe(2);
      expect(v2.assessmentId).not.toBe(v1.assessmentId);
      const rows = await pool.query(
        "select version from p2.case_assessment where case_id = $1 order by version",
        [v1.caseId],
      );
      expect(rows.rows.map((r: { version: number }) => r.version)).toEqual([1, 2]);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "assess");
    }
  });

  it("inactive references refuse the run before any write", async () => {
    const { draftPolicy } = await import("../lib/qualification/policy");
    const { fixturePolicy } = await import("./qualification_fixtures");
    const v = `p2t-inactive-${Date.now()}`;
    try {
      const s = await seedCompanyWithClaims(pool, "inact", [
        { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10 },
      ]);
      const oid = await seedOpp(s.companyId, "inact");
      await draftPolicy(pool, v, fixturePolicy(), ACTOR); // draft, never published
      await expect(runAssessment(pool, runInput(oid, { policyVersion: v }))).rejects.toMatchObject({
        code: "reference_not_active",
      });
      await expect(runAssessment(pool, runInput(oid, { policyVersion: "p2t-ghost" }))).rejects.toMatchObject({
        code: "unknown_reference_version",
      });
      // Nothing was recorded: no case, no assessment.
      const cases = await pool.query(
        "select count(*)::int as n from p2.case where discovery_opportunity_id = $1",
        [oid],
      );
      expect(cases.rows[0].n).toBe(0);
    } finally {
      await pool.query("delete from p2.scoring_policy where policy_version = $1", [v]);
      await pool.query("delete from p2.reference_version where kind = 'policy' and version = $1", [v]);
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "assess");
    }
  });

  it("an unknown opportunity is a 404 with no side effects", async () => {
    await expect(
      runAssessment(pool, runInput("11111111-2222-4333-8444-555555555555")),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("P2-assess: staleness names the exact change", () => {
  it("fresh assessments are clean; evidence moves flag them", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "stale", [
        { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10 },
      ]);
      const oid = await seedOpp(s.companyId, "stale");
      const r = await runAssessment(pool, runInput(oid));
      const fresh = await assessmentStaleness(pool, r.assessmentId);
      expect(fresh).toMatchObject({ stale: false, reasons: [] });
      // New evidence arrives: the snapshot hash moves.
      await pool.query(
        `insert into public.claim (company_id, snapshot_id, claim_text, claim_status, source_reliability, info_credibility, observed_at)
         values ($1, (select id from public.snapshot where company_id = $1 limit 1), 'Late news', 'observed', 'B', 2, now())`,
        [s.companyId],
      );
      const moved = await assessmentStaleness(pool, r.assessmentId);
      expect(moved.stale).toBe(true);
      expect(moved.reasons.join(" ")).toMatch(/moved/);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "assess");
    }
  });

  it("retired versions and suppression flag assessments stale", async () => {
    const { setReferenceStatus } = await import("../lib/qualification/cases");
    try {
      const s = await seedCompanyWithClaims(pool, "stale2", [
        { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10 },
      ]);
      const oid = await seedOpp(s.companyId, "stale2");
      const r = await runAssessment(pool, runInput(oid));
      await setReferenceStatus(pool, "policy", SET.policyVersion, "retired", ACTOR);
      const retired = await assessmentStaleness(pool, r.assessmentId);
      expect(retired.stale).toBe(true);
      expect(retired.reasons.join(" ")).toMatch(/no longer active/);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "assess");
    }
  });

  it("a removed opportunity flags its assessments", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "stalegone", [
        { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10 },
      ]);
      const oid = await seedOpp(s.companyId, "stalegone");
      const r = await runAssessment(pool, runInput(oid));
      await pool.query("delete from public.opportunity where id = $1", [oid]);
      const gone = await assessmentStaleness(pool, r.assessmentId);
      expect(gone.stale).toBe(true);
      expect(gone.reasons.join(" ")).toMatch(/no longer visible/);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "assess");
    }
  });

  it("suppression appearing after assessment flags it", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "stalesupp", [
        { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10 },
      ]);
      const oid = await seedOpp(s.companyId, "stalesupp");
      const r = await runAssessment(pool, runInput(oid));
      await transitionOpportunity(pool, oid, "archived", { actor: ACTOR, reason: "p2t" });
      const flagged = await assessmentStaleness(pool, r.assessmentId);
      expect(flagged.stale).toBe(true);
      expect(flagged.reasons.join(" ")).toMatch(/suppression/);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "assess");
    }
  });

  it("unknown assessments are 404", async () => {
    await expect(
      assessmentStaleness(pool, "11111111-2222-4333-8444-555555555555"),
    ).rejects.toMatchObject({ status: 404 });
  });
});
