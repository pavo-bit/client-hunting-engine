/**
 * Part 2 §8/§9: lexicographic ranking and research prioritization.
 *
 * Proven: only eligible + composite + floors-met leads rank; floors exclude
 * before any comparison (a high composite never conceals one); tiebreaks and
 * id order make the order total and reproducible; pairwise explanations cite
 * the deciding field; ranking snapshots persist with reproducible input
 * hashes; capacity marks a cutoff without deleting rows; research tasks
 * derive deterministically from gates + missing data + contradictions, persist
 * idempotently per question, and follow an operator workflow.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidenceBundle } from "../lib/qualification/evidence";
import { readQualificationRow, type QualificationRow } from "../lib/qualification/view";
import { score, type ScoreResult } from "../lib/qualification/scoring";
import {
  explainPairwise,
  rankLeads,
  recordRankingSnapshot,
} from "../lib/qualification/ranking";
import {
  proposeResearchTasks,
  saveResearchTasks,
  setResearchTaskStatus,
} from "../lib/qualification/research";
import { registerOpportunity } from "../lib/discovery/opportunities";
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
    sourceRecordId: `P2T-R-${stamp}`,
    companyId,
    actor: ACTOR,
  });
  return o.id;
}

async function scoreOf(companyId: string, opportunityId: string): Promise<ScoreResult> {
  const row = (await readQualificationRow(pool, opportunityId)) as QualificationRow;
  const bundle = await buildEvidenceBundle(pool, companyId, {
    asOf: AS_OF,
    signalMap: SET.policy.signalMap,
    freshnessDefaultDays: SET.policy.freshnessDefaultDays,
  });
  return score({
    row,
    bundle,
    policy: SET.policy,
    policyVersion: SET.policyVersion,
    services: [SET.service],
    catalogVersion: SET.catalogVersion,
    rubric: SET.rubric as never,
    rubricVersion: SET.rubricVersion,
    capacity: { version: SET.capacityVersion, definition: SET.capacity },
    operatorAnswers: {},
    asOf: AS_OF,
    requiredUsable: 1,
  });
}

beforeAll(async () => {
  await cleanupFixtures(pool);
  SET = await registerFixtureSet(pool, "rank");
});
afterAll(async () => {
  await cleanupFixtures(pool);
  await pool.end();
});

describe("P2-rank: lexicographic order with floors first", () => {
  it("ranks eligible leads, excludes the rest with reasons, and explains pairs", async () => {
    try {
      const rich = await seedCompanyWithClaims(pool, "rkrich", [
        { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10, link: "supports" },
        { text: "Directory confirms size", sourceKey: "agency-directory", observedDaysAgo: 20 },
      ]);
      const thin = await seedCompanyWithClaims(pool, "rkthin", [
        { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10 },
      ]);
      const orich = await seedOpp(rich.companyId, "rkrich");
      const othin = await seedOpp(thin.companyId, "rkthin");
      const sr = await scoreOf(rich.companyId, orich);
      const st = await scoreOf(thin.companyId, othin);
      expect(sr.outcome).toBe("eligible_for_assessment");
      const ranked = rankLeads(
        [
          { caseId: "case-rich", opportunityId: orich, score: sr },
          { caseId: "case-thin", opportunityId: othin, score: st },
        ],
        SET.policy,
        null,
      );
      const richRank = ranked.ordered.find((l) => l.caseId === "case-rich")!;
      const thinRank = ranked.ordered.find((l) => l.caseId === "case-thin")!;
      expect(richRank.rank).toBe(1);
      expect(thinRank.rank).toBe(2);
      expect(richRank.excludedReason).toBeNull();
      const expl = explainPairwise(
        { caseId: "case-rich", opportunityId: orich, score: sr, rank: richRank.rank },
        { caseId: "case-thin", opportunityId: othin, score: st, rank: thinRank.rank },
        SET.policy.ranking.tiebreak,
      );
      expect(expl).toMatch(/composite|evidence_confidence|need_strength/);

      // A floor failure excludes even with a high composite.
      const floored = rankLeads(
        [{ caseId: "case-rich", opportunityId: orich, score: sr }],
        { ...SET.policy, floors: { ...SET.policy.floors, evidence_confidence: 100 } },
        null,
      );
      expect(floored.ordered[0].rank).toBe(0);
      expect(floored.ordered[0].excludedReason).toMatch(/floor/);

      // maxActive marks the cutoff without removing rows.
      const cut = rankLeads(
        [
          { caseId: "case-rich", opportunityId: orich, score: sr },
          { caseId: "case-thin", opportunityId: othin, score: st },
        ],
        SET.policy,
        1,
      );
      expect(cut.ordered.find((l) => l.caseId === "case-rich")!.cutoff).toBe(false);
      expect(cut.ordered.find((l) => l.caseId === "case-thin")!.cutoff).toBe(true);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "rank");
    }
  });

  it("identical ranking inputs reproduce the input hash", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "rkhash", [
        { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10 },
      ]);
      const o = await seedOpp(s.companyId, "rkhash");
      const sc = await scoreOf(s.companyId, o);
      const a = rankLeads([{ caseId: "c1", opportunityId: o, score: sc }], SET.policy, null);
      const b = rankLeads([{ caseId: "c1", opportunityId: o, score: sc }], SET.policy, null);
      expect(b.inputHash).toBe(a.inputHash);
      expect(JSON.stringify(b.ordered)).toBe(JSON.stringify(a.ordered));
      const snap = await recordRankingSnapshot(pool, {
        policyVersion: SET.policyVersion,
        catalogVersion: SET.catalogVersion,
        rubricVersion: SET.rubricVersion,
        capacityVersion: SET.capacityVersion,
        asOf: AS_OF,
        ranked: a,
        actor: ACTOR,
      });
      expect(snap.inputHash).toBe(a.inputHash);
      const stored = await pool.query("select input_hash, ordered from p2.ranking_snapshot where ranking_id = $1", [
        snap.rankingId,
      ]);
      expect(stored.rows[0].input_hash).toBe(a.inputHash);
      expect(stored.rows[0].ordered).toHaveLength(1);
      await pool.query("delete from p2.ranking_snapshot where ranking_id = $1", [snap.rankingId]);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "rank");
    }
  });
});

describe("P2-research: decision-value task foundation", () => {
  it("derives ordered tasks from gates, missing data and contradictions", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "rsch", [
        { text: "Need portals", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 500, link: "contradicts" },
      ]);
      const o = await seedOpp(s.companyId, "rsch");
      const sc = await scoreOf(s.companyId, o);
      const tasks = proposeResearchTasks(sc, { availableSources: ["company-site", "registry"] });
      expect(tasks.length).toBeGreaterThan(0);
      // Gate tasks first (highest decision impact), then deterministic order.
      expect(tasks[0].reasonCode).toMatch(/^GATE_/);
      const again = proposeResearchTasks(sc, { availableSources: ["company-site", "registry"] });
      expect(again).toEqual(tasks);
      // Every task carries the full decision-value shape; nothing promises value.
      for (const t of tasks) {
        expect(t.question.length).toBeGreaterThan(0);
        expect(t.evidenceNeeded.length).toBeGreaterThan(0);
        expect(t.priorityExplanation.length).toBeGreaterThan(0);
        expect(JSON.stringify(t)).not.toMatch(/probability|guaranteed value/i);
      }
      const contra = tasks.find((t) => t.reasonCode === "CONTRADICTION_OPEN");
      expect(contra).toBeTruthy();
      expect(contra!.expectedImpact).toBe("high");
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "rank");
    }
  });

  it("persists idempotently per question and follows an operator workflow", async () => {
    const { ensureCase } = await import("../lib/qualification/cases");
    const { recordSnapshot } = await import("../lib/qualification/cases");
    try {
      const s = await seedCompanyWithClaims(pool, "rtask", [
        { text: "Need portals", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 500 },
      ]);
      const o = await seedOpp(s.companyId, "rtask");
      const row = (await readQualificationRow(pool, o)) as QualificationRow;
      const { kase } = await ensureCase(pool, row, ACTOR);
      const snap = await recordSnapshot(pool, kase.case_id, row, ACTOR, "research-test");
      const sc = await scoreOf(s.companyId, o);
      const proposed = proposeResearchTasks(sc, { availableSources: ["company-site"] });
      expect(proposed.length).toBeGreaterThan(0);
      const first = await saveResearchTasks(pool, kase.case_id, snap.snapshotId, proposed);
      expect(first.created).toBe(proposed.length);
      const second = await saveResearchTasks(pool, kase.case_id, snap.snapshotId, proposed);
      expect(second).toEqual({ created: 0, existing: proposed.length });
      const one = await pool.query("select task_id from p2.research_task where case_id = $1 limit 1", [kase.case_id]);
      const taskId = one.rows[0].task_id as string;
      await expect(setResearchTaskStatus(pool, taskId, "done", ACTOR)).rejects.toMatchObject({
        code: "bad_task_transition",
      });
      const accepted = await setResearchTaskStatus(pool, taskId, "accepted", ACTOR, "operator will check");
      expect(accepted.status).toBe("accepted");
      const done = await setResearchTaskStatus(pool, taskId, "done", ACTOR);
      expect(done.status).toBe("done");
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "rank");
    }
  });
});
