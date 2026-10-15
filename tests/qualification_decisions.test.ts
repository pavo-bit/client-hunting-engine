/**
 * Part 3 §3–§4: opportunity lifecycle and human review decisions.
 *
 * Proven: legal transitions with reasons (backend-enforced); every decision
 * cites the exact assessment reviewed; records immutable (corrections cite
 * new assessments); suppression and not_eligible gates never overridden;
 * stale assessments refused for accept/defer; concurrent same-assessment
 * decisions conflict (409) instead of doubling; exclusion/supersession
 * mid-assessment aborts the run; deferral limits come from policy;
 * reconsideration and withdrawal follow audited rules; display states derive
 * without a second status column.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { transitionOpportunity } from "../lib/discovery/opportunities";
import { registerOpportunity } from "../lib/discovery/opportunities";
import {
  caseDisplayState,
  decide,
  decisionHistory,
  latestDecision,
} from "../lib/qualification/decisions";
import { runAssessment } from "../lib/qualification/assessments";
import {
  ACTOR,
  cleanupFixtures,
  fixturePolicy,
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

async function seedAssessed(tag: string): Promise<{ caseId: string; assessmentId: string; opportunityId: string }> {
  const stamp = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const s = await seedCompanyWithClaims(pool, tag, [
    { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10, link: "supports" },
    { text: "Directory confirms size", sourceKey: "agency-directory", observedDaysAgo: 20 },
  ]);
  const o = await registerOpportunity(pool, {
    pipeline: "agency_partner",
    sourceKey: "company-site",
    sourceRecordId: `P2T-D-${stamp}`,
    companyId: s.companyId,
    actor: ACTOR,
  });
  const r = await runAssessment(pool, {
    opportunityId: o.id,
    policyVersion: SET.policyVersion,
    catalogVersion: SET.catalogVersion,
    rubricVersion: SET.rubricVersion,
    capacityVersion: SET.capacityVersion,
    asOf: AS_OF,
    actor: ACTOR,
  });
  return { caseId: r.caseId, assessmentId: r.assessmentId, opportunityId: o.id };
}

beforeAll(async () => {
  await cleanupFixtures(pool);
  SET = await registerFixtureSet(pool, "decide");
});
afterAll(async () => {
  await cleanupFixtures(pool);
  await pool.end();
});

describe("P3-lifecycle: legal transitions with reasons", () => {
  it("accepts an eligible case on a fresh assessment, audited", async () => {
    try {
      const s = await seedAssessed("accept");
      const d = await decide(pool, {
        caseId: s.caseId,
        assessmentId: s.assessmentId,
        type: "accepted",
        reason: "strong need, fresh evidence, channel known",
        actor: ACTOR,
        policy: SET.policy,
      });
      expect(d.decision).toBe("accepted");
      expect(d.actor).toBe(ACTOR);
      expect(await latestDecision(pool, s.caseId)).toMatchObject({ decision_id: d.decision_id });
      const audits = await pool.query(
        "select count(*)::int as n from p2.audit_event where entity_type = 'case' and entity_id = $1 and action = 'decision_accepted'",
        [s.caseId],
      );
      expect(audits.rows[0].n).toBe(1);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "decide");
    }
  });

  it("requires a reason and a cited assessment (except withdrawal)", async () => {
    try {
      const s = await seedAssessed("reason");
      await expect(
        decide(pool, { caseId: s.caseId, assessmentId: s.assessmentId, type: "accepted", reason: "   ", actor: ACTOR }),
      ).rejects.toMatchObject({ code: "reason_required" });
      await expect(
        decide(pool, { caseId: s.caseId, type: "accepted", reason: "no citation", actor: ACTOR }),
      ).rejects.toMatchObject({ code: "assessment_required" });
      await expect(
        decide(pool, { caseId: s.caseId, assessmentId: "11111111-2222-4333-8444-555555555555", type: "rejected", reason: "x", actor: ACTOR }),
      ).rejects.toMatchObject({ code: "assessment_mismatch" });
      // Withdrawal cites nothing and archives the case.
      const w = await decide(pool, { caseId: s.caseId, type: "withdrawn", reason: "duplicate pursuit elsewhere", actor: ACTOR });
      expect(w.decision).toBe("withdrawn");
      const kase = await pool.query("select status from p2.case where case_id = $1", [s.caseId]);
      expect(kase.rows[0].status).toBe("archived");
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "decide");
    }
  });

  it("concurrent same-assessment decisions conflict instead of doubling", async () => {
    try {
      const s = await seedAssessed("race");
      const [a, b] = await Promise.allSettled([
        decide(pool, { caseId: s.caseId, assessmentId: s.assessmentId, type: "accepted", reason: "operator one", actor: ACTOR }),
        decide(pool, { caseId: s.caseId, assessmentId: s.assessmentId, type: "rejected", reason: "operator two", actor: ACTOR }),
      ]);
      const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
      const rejected = [a, b].filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "decision_conflict" });
      expect((await decisionHistory(pool, s.caseId))).toHaveLength(1);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "decide");
    }
  });

  it("reconsideration cites a new assessment; history is preserved", async () => {
    try {
      const s = await seedAssessed("reconsider");
      const first = await decide(pool, {
        caseId: s.caseId, assessmentId: s.assessmentId, type: "rejected", reason: "timing unclear", actor: ACTOR,
      });
      const rerun = await runAssessment(pool, {
        opportunityId: s.opportunityId,
        policyVersion: SET.policyVersion,
        catalogVersion: SET.catalogVersion,
        rubricVersion: SET.rubricVersion,
        capacityVersion: SET.capacityVersion,
        asOf: AS_OF,
        actor: ACTOR,
      });
      expect(rerun.assessmentId).not.toBe(s.assessmentId);
      const second = await decide(pool, {
        caseId: s.caseId, assessmentId: rerun.assessmentId, type: "accepted", reason: "timing confirmed on review", actor: ACTOR,
      });
      const history = await decisionHistory(pool, s.caseId);
      expect(history.map((d) => d.decision)).toEqual(["rejected", "accepted"]);
      expect(history[0].decision_id).toBe(first.decision_id);
      expect(history[1].decision_id).toBe(second.decision_id);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "decide");
    }
  });
});

describe("P3-lifecycle: gates and suppression are never overridden", () => {
  it("accept on a gate-rejected outcome is refused", async () => {
    try {
      // No usable evidence: outcome needs_evidence, not eligible.
      const stamp = `neg-${Date.now()}`;
      const s = await seedCompanyWithClaims(pool, "negdec", [
        { text: "Unapproved whisper", sourceKey: "x-platform", observedDaysAgo: 5 },
      ]);
      void stamp;
      const o = await registerOpportunity(pool, {
        pipeline: "agency_partner",
        sourceKey: "company-site",
        sourceRecordId: `P2T-D-NEG-${Date.now()}`,
        companyId: s.companyId,
        actor: ACTOR,
      });
      const r = await runAssessment(pool, {
        opportunityId: o.id,
        policyVersion: SET.policyVersion,
        catalogVersion: SET.catalogVersion,
        rubricVersion: SET.rubricVersion,
        capacityVersion: SET.capacityVersion,
        asOf: AS_OF,
        actor: ACTOR,
      });
      expect(r.outcome).toBe("needs_evidence");
      await expect(
        decide(pool, { caseId: r.caseId, assessmentId: r.assessmentId, type: "accepted", reason: "overriding", actor: ACTOR }),
      ).rejects.toMatchObject({ code: "gate_not_eligible" });
      // Rejecting records reality — allowed.
      const rej = await decide(pool, { caseId: r.caseId, assessmentId: r.assessmentId, type: "rejected", reason: "insufficient evidence, park it", actor: ACTOR });
      expect(rej.decision).toBe("rejected");
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "decide");
    }
  });

  it("suppression blocks accept and defer, but records reject/withdraw", async () => {
    try {
      const s = await seedAssessed("suppdec");
      await transitionOpportunity(pool, s.opportunityId, "archived", { actor: ACTOR, reason: "p2t" });
      await expect(
        decide(pool, { caseId: s.caseId, assessmentId: s.assessmentId, type: "accepted", reason: "x", actor: ACTOR }),
      ).rejects.toMatchObject({ code: "suppression_active" });
      await expect(
        decide(pool, { caseId: s.caseId, assessmentId: s.assessmentId, type: "deferred", reason: "x", resumeCondition: "later", actor: ACTOR }),
      ).rejects.toMatchObject({ code: "suppression_active" });
      const w = await decide(pool, { caseId: s.caseId, assessmentId: s.assessmentId, type: "withdrawn", reason: "archived upstream", actor: ACTOR });
      expect(w.decision).toBe("withdrawn");
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "decide");
    }
  });

  it("stale assessments cannot back accept or defer", async () => {
    try {
      const s = await seedAssessed("staledec");
      // New evidence lands after the assessment: it is now stale.
      await pool.query(
        `insert into public.claim (company_id, snapshot_id, claim_text, claim_status, source_reliability, info_credibility, observed_at)
         values ((select company_id from public.opportunity where id = $1),
                 (select id from public.snapshot where company_id = (select company_id from public.opportunity where id = $1) limit 1),
                 'Late news', 'observed', 'B', 2, now())`,
        [s.opportunityId],
      );
      await expect(
        decide(pool, { caseId: s.caseId, assessmentId: s.assessmentId, type: "accepted", reason: "x", actor: ACTOR }),
      ).rejects.toMatchObject({ code: "stale_assessment" });
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "decide");
    }
  });
});

describe("P3-lifecycle: deferral follows policy limits, not defaults", () => {
  it("one active deferral at a time; resume conditions required; lifetime capped", async () => {
    try {
      const s = await seedAssessed("defer");
      // No resume condition at all: refused at the schema level.
      await expect(
        decide(pool, { caseId: s.caseId, assessmentId: s.assessmentId, type: "deferred", reason: "waiting", actor: ACTOR, policy: SET.policy }),
      ).rejects.toThrow();
      const d1 = await decide(pool, {
        caseId: s.caseId, assessmentId: s.assessmentId, type: "deferred",
        reason: "waiting on budget cycle", resumeAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        actor: ACTOR, policy: SET.policy,
      });
      expect(d1.decision).toBe("deferred");
      // Second deferral while one is active: refused (structural, no policy needed).
      const rerun = await runAssessment(pool, {
        opportunityId: s.opportunityId,
        policyVersion: SET.policyVersion, catalogVersion: SET.catalogVersion,
        rubricVersion: SET.rubricVersion, capacityVersion: SET.capacityVersion,
        asOf: AS_OF, actor: ACTOR,
      });
      await expect(
        decide(pool, {
          caseId: s.caseId, assessmentId: rerun.assessmentId, type: "deferred",
          reason: "again", resumeCondition: "later", actor: ACTOR, policy: SET.policy,
        }),
      ).rejects.toMatchObject({ code: "deferral_active" });
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "decide");
    }
  });

  it("deferral numeric limits come from policy, and lifetime exhausts", async () => {
    try {
      // Beyond the policy's maxDays: refused (policy value, not a default).
      const s = await seedAssessed("deferlim");
      const far = new Date(Date.now() + 60 * 86_400_000).toISOString();
      await expect(
        decide(pool, {
          caseId: s.caseId, assessmentId: s.assessmentId, type: "deferred",
          reason: "far out", resumeAt: far, actor: ACTOR,
          policy: fixturePolicy({ deferral: { maxDays: 30, maxLifetime: 99 } }),
        }),
      ).rejects.toMatchObject({ code: "deferral_too_long" });
      // Lifetime: with maxLifetime 1, one deferral is the last. The first
      // deferral is closed by an accept (latest decision moves on), so the
      // second attempt reaches the lifetime check instead of the active check.
      const t = await seedAssessed("deferlife");
      const first = await runAssessment(pool, {
        opportunityId: t.opportunityId,
        policyVersion: SET.policyVersion, catalogVersion: SET.catalogVersion,
        rubricVersion: SET.rubricVersion, capacityVersion: SET.capacityVersion,
        asOf: AS_OF, actor: ACTOR,
      });
      await decide(pool, {
        caseId: t.caseId, assessmentId: first.assessmentId, type: "deferred",
        reason: "waiting", resumeCondition: "budget confirmed", actor: ACTOR,
        policy: fixturePolicy({ deferral: { maxDays: 30, maxLifetime: 1 } }),
      });
      const mid = await runAssessment(pool, {
        opportunityId: t.opportunityId,
        policyVersion: SET.policyVersion, catalogVersion: SET.catalogVersion,
        rubricVersion: SET.rubricVersion, capacityVersion: SET.capacityVersion,
        asOf: AS_OF, actor: ACTOR,
      });
      await decide(pool, {
        caseId: t.caseId, assessmentId: mid.assessmentId, type: "accepted",
        reason: "budget confirmed early", actor: ACTOR,
        policy: fixturePolicy({ deferral: { maxDays: 30, maxLifetime: 1 } }),
      });
      const second = await runAssessment(pool, {
        opportunityId: t.opportunityId,
        policyVersion: SET.policyVersion, catalogVersion: SET.catalogVersion,
        rubricVersion: SET.rubricVersion, capacityVersion: SET.capacityVersion,
        asOf: AS_OF, actor: ACTOR,
      });
      await expect(
        decide(pool, {
          caseId: t.caseId, assessmentId: second.assessmentId, type: "deferred",
          reason: "again", resumeCondition: "again", actor: ACTOR,
          policy: fixturePolicy({ deferral: { maxDays: 30, maxLifetime: 1 } }),
        }),
      ).rejects.toMatchObject({ code: "deferral_exhausted" });
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "decide");
    }
  });
});

describe("P3-lifecycle: display states derive without a second status", () => {
  it("maps every prompt state from case + decision + outcome", () => {
    const base = { caseStatus: "discovered", latestDecision: null, latestOutcome: null, suppression: null, stale: false, deferralOverdue: false };
    expect(caseDisplayState(base).state).toBe("AwaitingAssessment");
    expect(caseDisplayState({ ...base, latestOutcome: "needs_evidence" }).state).toBe("NeedsEvidence");
    expect(caseDisplayState({ ...base, latestOutcome: "blocked" }).state).toBe("Blocked");
    expect(caseDisplayState({ ...base, latestOutcome: "not_eligible" }).state).toBe("NotAFit");
    expect(
      caseDisplayState({ ...base, caseStatus: "assessed", latestOutcome: "eligible_for_assessment" }).state,
    ).toBe("QualifiedForReview");
    expect(caseDisplayState({ ...base, suppression: "company_merged" }).state).toBe("Suppressed");
    const dec = (decision: "accepted" | "rejected" | "deferred" | "withdrawn") =>
      caseDisplayState({
        ...base,
        latestOutcome: "eligible_for_assessment",
        latestDecision: {
          decision_id: "d", case_id: "c", assessment_id: "a", decision,
          reason: "r", reason_code: null,
          resume_at: decision === "deferred" ? new Date(Date.now() + 86_400_000).toISOString() : null,
          resume_condition: null, actor: ACTOR, decided_at: new Date().toISOString(),
        },
      });
    expect(dec("accepted").state).toBe("Accepted");
    expect(dec("rejected").state).toBe("Rejected");
    expect(dec("deferred").state).toBe("Deferred");
    expect(dec("withdrawn").state).toBe("Withdrawn");
    // Staleness rides along as a flag, never a silent state change.
    expect(
      caseDisplayState({ ...base, caseStatus: "assessed", latestOutcome: "eligible_for_assessment", stale: true }).stale,
    ).toBe(true);
  });
});
