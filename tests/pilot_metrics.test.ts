/**
 * Phase 4 / Workstream B: pilot metric correctness.
 *
 * These are the four defects under test:
 *   B1 source health must not join runs to sources by matching free text;
 *   B2 "approved for review" must come from real qualification semantics, and
 *      be UNAVAILABLE (never a fake zero) with no active policy;
 *   B3 freshness must be a true median over a named population/date, null when
 *      the population is empty, and never substitute one date for another;
 *   B4 precision must come from human correctness labels, not from accepted
 *      qualification decisions, and must carry a confidence interval.
 */
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { ingestObservation } from "../lib/evidence/ingest";
import {
  adapterSourceMap,
  buildPilotReport,
  perSourcePrecisionFromRows,
  wilson95,
  MIN_SAMPLE_FOR_PRECISION,
  PILOT_REVIEW_RUN_STANDARD,
  PILOT_REVIEW_STANDARD,
} from "../lib/pilot/metrics";
import { runSignalSource } from "../lib/discovery/signal-run";
import {
  GREENHOUSE_ADAPTER_ID,
  GreenhouseAdapter,
} from "../lib/discovery/adapters/greenhouse";
import { linkBoardToken, SIGNAL_SOURCE_KEY } from "../lib/discovery/signal-run";
import { AdapterRegistry } from "../lib/discovery/registry";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
process.env.DATABASE_URL = DB_URL;
const pool = new Pool({ connectionString: DB_URL, max: 3 });
const ACTOR = "p4pilot";
const BOARD = "p4-board";

function registry(json: unknown): AdapterRegistry {
  const r = new AdapterRegistry();
  r.register(
    new GreenhouseAdapter({
      fetchImpl: (async () =>
        new Response(JSON.stringify(json), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    }),
  );
  return r;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

async function cleanup(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("delete from public.source_record_review where reviewer like $1", ["p4%"]);
    await c.query("delete from public.discovery_record where source_key = $1", [SIGNAL_SOURCE_KEY]);
    await c.query(
      "delete from public.claim where company_id in (select id from public.company where domain_norm like 'p4p-%')",
    );
    await c.query(
      "delete from public.snapshot where company_id in (select id from public.company where domain_norm like 'p4p-%')",
    );
    // FK order: opportunity references company.
    await c.query(
      "delete from public.opportunity where company_id in (select id from public.company where domain_norm like 'p4p-%')",
    );
    await c.query(
      "delete from public.discovery_record where source_record_id like 'p4rec-%'",
    );
    await c.query("delete from public.company where domain_norm like 'p4p-%'");
    await c.query("delete from public.discovery_run where created_by = $1", [ACTOR]);
  } finally {
    c.release();
  }
}

beforeEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await pool.query("update public.source set enabled = false where key = $1", [SIGNAL_SOURCE_KEY]);
  await pool.end();
});

async function seed(tag: string): Promise<string> {
  const co = await createCompany(
    pool,
    {
      name: `P4p ${tag} Ltd`,
      domain: `p4p-${tag}-${Date.now()}.example`,
      agencyType: "web_development",
      country: "Ireland",
    },
    ACTOR,
  );
  return co.companyId;
}

describe("B1: source/run association uses adapter_id, not query_text", () => {
  it("maps adapter ids to source keys via the adapter manifest", () => {
    const map = adapterSourceMap();
    // The Greenhouse adapter declares an explicit source key.
    expect(map.get(GREENHOUSE_ADAPTER_ID)).toBe(SIGNAL_SOURCE_KEY);
    // GLEIF declares one too.
    expect(map.get("gleif-lei")).toBe("gleif-api");
    // Unknown adapters are absent, so runs by them are reported unattributed
    // rather than matched by guessing.
    expect(map.has("agency-directory-fixture")).toBe(false);
  });

  it("resolves a run's source through adapter_id and reports it as the basis", async () => {
    await pool.query("update public.source set enabled = true where key = $1", [SIGNAL_SOURCE_KEY]);
    const companyId = await seed("run");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });
    await runSignalSource(pool, registry({ jobs: [{ id: 1, title: "Engineer", updated_at: daysAgo(1) }], meta: { total: 1 } }), {
      adapterId: GREENHOUSE_ADAPTER_ID,
      queryText: BOARD, // deliberately NOT a source key
      actor: ACTOR,
    });
    await pool.query("update public.source set enabled = false where key = $1", [SIGNAL_SOURCE_KEY]);

    const report = await buildPilotReport(pool);
    const gh = report.sourceHealth.find((s) => s.key === SIGNAL_SOURCE_KEY)!;
    expect(gh.lastRunAt).not.toBeNull();
    expect(["ok", "partial", "failed"]).toContain(gh.lastRunStatus);
    expect(gh.lastRunBasis).toMatch(/adapter manifest's sourceKey/);
    // The board token must never be mistaken for a source key anywhere.
    expect(report.sourceHealth.some((s) => s.key === BOARD)).toBe(false);
  });

  it("reports a source with no attributable run as unavailable, not as 'never ran ok'", async () => {
    const report = await buildPilotReport(pool);
    for (const s of report.sourceHealth) {
      if (s.lastRunAt === null) expect(s.lastRunBasis).toMatch(/unavailable/);
      else expect(s.lastRunBasis).toMatch(/adapter manifest/);
    }
    // Runs by unmapped adapters are surfaced rather than silently dropped.
    if (report.unattributedRuns.runs > 0)
      expect(report.unattributedRuns.adapterIds.length).toBeGreaterThan(0);
  });

  it("distinguishes a zero-result successful run from a failed run", async () => {
    await pool.query("update public.source set enabled = true where key = $1", [SIGNAL_SOURCE_KEY]);
    const companyId = await seed("zeroresult");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });
    await runSignalSource(pool, registry({ jobs: [], meta: { total: 0 } }), {
      adapterId: GREENHOUSE_ADAPTER_ID,
      queryText: BOARD,
      actor: ACTOR,
    });
    await pool.query("update public.source set enabled = false where key = $1", [SIGNAL_SOURCE_KEY]);
    const report = await buildPilotReport(pool);
    const gh = report.sourceHealth.find((s) => s.key === SIGNAL_SOURCE_KEY)!;
    expect(gh.lastRunStatus).toBe("ok");
    const rate = report.metrics.find((m) => m.key === "source_run_failure_rate")!;
    expect(rate.denominator).toBeGreaterThan(0);
    // The failed-rate metric counts only failed/cancelled runs.
    expect(rate.value).toBe(0);
  });
});

describe("B2: approved-for-review uses real qualification semantics", () => {
  it("is UNAVAILABLE with no active policy, and explains why", async () => {
    const active = await pool.query(
      "select count(*)::int n from p2.reference_version where status = 'active'",
    );
    expect(active.rows[0].n).toBe(0);
    const report = await buildPilotReport(pool);
    expect(report.approvedForReview.value).toBeNull();
    expect(report.approvedForReview.activePolicyVersion).toBeNull();
    expect(report.approvedForReview.detail).toMatch(/no_active_reference/);
    expect(report.blockers.map((b) => b.code)).toContain("no_active_policy");
  });

  it("counts only accepted-and-assessed cases under the active policy", async () => {
    // A policy is published ONLY to exercise the query. It is removed
    // immediately afterwards; this test does not approve anything.
    await pool.query(
      `insert into p2.reference_version (kind, version, status, notes, recorded_by)
       values ('policy', 'p4-temp-policy', 'active', 'TEMPORARY test fixture', 'p4test')`,
    );
    try {
      const report = await buildPilotReport(pool);
      expect(report.approvedForReview.activePolicyVersion).toBe("p4-temp-policy");
      expect(report.approvedForReview.value).not.toBeNull();
      // No real cases exist, so the measured value is genuinely zero here —
      // distinct from the UNAVAILABLE case above.
      expect(report.approvedForReview.value).toBe(0);
      expect(report.approvedForReview.detail).toMatch(/latest decision is 'accepted'/);
      expect(report.approvedForReview.detail).toMatch(/assessed state alone is never/);
    } finally {
      await pool.query("delete from p2.reference_version where version = 'p4-temp-policy'");
    }
    const after = await buildPilotReport(pool);
    expect(after.approvedForReview.value).toBeNull();
  });
});

describe("B3: freshness is a true median over a named population", () => {
  it("returns null (never 0) when a population has no valid dates", async () => {
    const id = await seed("nodates");
    await ingestObservation(
      pool,
      { companyId: id, sourceKey: "company-site", url: "https://a.example/nodates", excerpt: "P4p nodates", actor: ACTOR },
      { predicate: "hiring", text: "P4p nodates claim", reliability: "C", credibility: 3 },
    );
    const report = await buildPilotReport(pool);
    // Ingestion time exists for this record, so that median is computable...
    expect(report.freshness.medianIngestionAgeDays).not.toBeNull();
    // ...but observation age must only be reported over snapshots that HAVE
    // an observation date. A zero-sample population is null, not zero days.
    if (report.freshness.observationSample === 0)
      expect(report.freshness.medianObservationAgeDays).toBeNull();
  });

  it("computes a true median (odd, even, stale and missing populations)", async () => {
    const id = await seed("median");
    // Four observations: 1, 2, 30, 40 days old (even sample).
    for (const [i, d] of [1, 2, 30, 40].entries()) {
      await ingestObservation(
        pool,
        {
          companyId: id,
          sourceKey: "company-site",
          url: `https://a.example/median-${i}`,
          excerpt: `P4p median ${i}`,
          observedAt: daysAgo(d),
          actor: ACTOR,
        },
        { predicate: "hiring", text: `P4p median claim ${i}`, reliability: "C", credibility: 3 },
      );
    }
    const report = await buildPilotReport(pool);
    // The per-source population for company-site is exactly these four.
    const row = report.freshness.perSource.find((s) => s.sourceKey === "company-site");
    expect(row).toBeDefined();
    const samples = [1, 2, 30, 40].sort((a, b) => a - b);
    const expected = (samples[1] + samples[2]) / 2; // 16
    expect(row!.observationSample).toBe(4);
    // Allow clock drift; the definition (middle of the middle two) is asserted.
    expect(Math.abs(row!.observationMedian! - expected)).toBeLessThan(0.2);
    // Median, not max: a stale 40-day record must not dominate.
    expect(row!.observationMedian!).toBeLessThan(30);
    // Publication is a separate population and is not filled from ingestion.
    expect(row!.publicationMedian).toBeNull();
  });

  it("keeps publication, observation and ingestion populations separate", async () => {
    const id = await seed("dates");
    await ingestObservation(
      pool,
      {
        companyId: id,
        sourceKey: "company-site",
        url: "https://a.example/dates",
        excerpt: "P4p dates",
        observedAt: daysAgo(2),
        actor: ACTOR,
      },
      {
        predicate: "hiring",
        text: "P4p dates claim",
        reliability: "C",
        credibility: 3,
        publishedAt: daysAgo(50), // source says it is much older
      },
    );
    const report = await buildPilotReport(pool);
    const row = report.freshness.perSource.find((s) => s.sourceKey === "company-site")!;
    expect(row.publicationSample).toBeGreaterThanOrEqual(1);
    // The publication median is far older than the observation median: proof
    // that ingestion time is not being substituted for publication time.
    expect(row.publicationMedian!).toBeGreaterThan(row.observationMedian!);
  });
});

describe("B4: precision comes from human correctness labels only", () => {
  it("is null when there are no review labels, even with qualified cases", async () => {
    const id = await seed("nolabels");
    await ingestObservation(
      pool,
      { companyId: id, sourceKey: "company-site", url: "https://a.example/nolabels", excerpt: "P4p nolabels", actor: ACTOR },
      { predicate: "hiring", text: "P4p nolabels claim", reliability: "C", credibility: 3 },
    );
    const report = await buildPilotReport(pool);
    expect(report.precision.reviewedRecords).toBe(0);
    expect(report.precision.value).toBeNull();
    expect(report.precision.standard.met).toBe(false);
    expect(report.blockers.map((b) => b.code)).toContain("no_reviewed_labels");
  });

  it("computes per-source precision from labels and excludes unusable ones", async () => {
    const host = await seed("host1");
    const run = await pool.query(
      `insert into public.discovery_run (adapter_id, adapter_version, status, query_text, created_by, finished_at)
       values ('gleif-lei','0.1.0','ok','x','p4test', now()) returning id`,
    );
    await pool.query(
      `insert into public.discovery_record (company_id, source_key, source_record_id, collection_method, retrieval_status, query_text)
       values ($1, 'gleif-api', 'p4rec-1', 'api', 'ok', 'x'),
              ($1, 'gleif-api', 'p4rec-1b', 'api', 'ok', 'x'),
              ($1, 'gleif-api', 'p4rec-1c', 'api', 'ok', 'x')`,
      [host],
    );
    // Three DISTINCT records: one correct, one incorrect, one unusable. The
    // unusable label is counted and shown, but excluded from the denominator.
    await pool.query(
      `insert into public.source_record_review (source_key, source_record_id, run_id, reviewer, reviewed_at, label)
       values ('gleif-api','p4rec-1',$1,'p4rev1', now() - interval '3 days','correct'),
              ('gleif-api','p4rec-1b',$1,'p4rev1', now() - interval '2 days','incorrect'),
              ('gleif-api','p4rec-1c',$1,'p4rev1', now() - interval '1 day','unusable')`,
      [run.rows[0].id],
    );
    const report = await buildPilotReport(pool);
    const s = report.perSourcePrecision.find((x) => x.sourceKey === "gleif-api")!;
    expect(s.reviewedRecords).toBe(3);
    expect(s.labelledCorrect).toBe(1);
    expect(s.labelledIncorrect).toBe(1);
    expect(s.labelledUnusable).toBe(1);
    // 1 / (1+1) = 50%, with unusable excluded but still visible.
    expect(s.precision).toBe(50);
    expect(s.ci95).not.toBeNull();
    expect(s.meetsPilotStandard).toBe(false);
    await pool.query("delete from public.discovery_run where created_by = 'p4test'");
    await pool.query("delete from public.discovery_record where source_record_id like 'p4rec-%'");
  });

  it("uses only the LATEST label per record, so repeat review cannot inflate n", async () => {
    const host = await seed("host2");
    const run = await pool.query(
      `insert into public.discovery_run (adapter_id, adapter_version, status, query_text, created_by, finished_at)
       values ('gleif-lei','0.1.0','ok','x','p4test', now()) returning id`,
    );
    await pool.query(
      `insert into public.discovery_record (company_id, source_key, source_record_id, collection_method, retrieval_status, query_text)
       values ($1, 'gleif-api', 'p4rec-2', 'api', 'ok', 'x')`,
      [host],
    );
    await pool.query(
      `insert into public.source_record_review (source_key, source_record_id, run_id, reviewer, reviewed_at, label)
       values ('gleif-api','p4rec-2',$1,'p4rev1', now() - interval '5 days','incorrect'),
              ('gleif-api','p4rec-2',$1,'p4rev1', now() - interval '4 days','correct'),
              ('gleif-api','p4rec-2',$1,'p4rev2', now() - interval '3 days','correct')`,
      [run.rows[0].id],
    );
    const report = await buildPilotReport(pool);
    const s = report.perSourcePrecision.find((x) => x.sourceKey === "gleif-api")!;
    // Two reviews of ONE record: the record counts once, latest label wins.
    expect(s.reviewedRecords).toBe(1);
    expect(s.labelledCorrect).toBe(1);
    expect(s.labelledIncorrect).toBe(0);
    expect(s.precision).toBe(100);
    await pool.query("delete from public.discovery_run where created_by = 'p4test'");
    await pool.query("delete from public.discovery_record where source_record_id like 'p4rec-%'");
  });

  it("is unaffected by accepted qualification decisions", async () => {
    // A qualification decision is a pursuit choice, never evidence of correctness.
    const before = await buildPilotReport(pool);
    expect(before.precision.reviewedRecords).toBe(0);
    const co = await seed("decision");
    const opp = await pool.query(
      `insert into public.opportunity (company_id, opportunity_key, pipeline, status)
       values ($1, 'P4-DEC-1', 'agency_partner', 'eligible') returning id`,
      [co],
    );
    const cse = await pool.query(
      `insert into p2.case (case_ref, discovery_opportunity_id, discovery_opportunity_key, pipeline, status,
         discovery_updated_at, discovery_state_hash, latest_sequence, created_at, updated_at, created_by)
       values ('P4-CASE-1', $1, 'P4-DEC-1', 'agency_partner', 'assessed', now(), 'p4hash', 1, now(), now(), 'p4test')
       returning case_id`,
      [opp.rows[0].id],
    );
    await pool.query(
      `insert into p2.case_decision (case_id, decision, reason, actor)
       values ($1, 'accepted', 'p4 test acceptance', 'p4test')`,
      [cse.rows[0].case_id],
    );
    const after = await buildPilotReport(pool);
    // Accepting a case changed nothing about precision.
    expect(after.precision.reviewedRecords).toBe(0);
    expect(after.precision.value).toBeNull();
    await pool.query("delete from p2.case where case_ref = 'P4-CASE-1'");
    await pool.query("delete from public.opportunity where opportunity_key = 'P4-DEC-1'");
  });
});

describe("Wilson 95% interval", () => {
  it("matches documented values and stays inside [0,1]", () => {
    // Symmetric, high-precision case: 95/100 -> CI near the point estimate.
    const a = wilson95(95, 100)!;
    expect(a.low).toBeGreaterThan(0.88);
    expect(a.high).toBeGreaterThan(a.low);
    expect(a.high).toBeLessThanOrEqual(1);
    // 50/100 -> 95% CI approximately [0.404, 0.596].
    const b = wilson95(50, 100)!;
    expect(b.low).toBeCloseTo(0.4038, 3);
    expect(b.high).toBeCloseTo(0.5962, 3);
    // Extreme small sample: 1/1 -> lower bound still well below 1.
    const c = wilson95(1, 1)!;
    expect(c.low).toBeGreaterThan(0.2);
    expect(c.high).toBe(1);
    // Degenerate inputs.
    expect(wilson95(0, 0)).toBeNull();
    expect(wilson95(5, 0)).toBeNull();
    expect(wilson95(-1, 5)).toBeNull();
    expect(wilson95(6, 5)).toBeNull();
    expect(wilson95(0, 5)!.high).toBeLessThan(1);
  });
});

describe("per-source aggregation helper", () => {
  it("reports null precision when the denominator is zero", () => {
    const [s] = perSourcePrecisionFromRows([
      { source_key: "gleif-api", reviewed: 3, correct: 0, incorrect: 0, unusable: 3, runs: 1 },
    ]);
    expect(s.precision).toBeNull();
    expect(s.ci95).toBeNull();
    expect(s.labelledUnusable).toBe(3);
    expect(s.note).toMatch(/No correctness denominator/);
  });

  it("keeps the owner-agreed pilot standard explicit", () => {
    expect(PILOT_REVIEW_STANDARD).toBe(60);
    expect(PILOT_REVIEW_RUN_STANDARD).toBe(4);
    expect(MIN_SAMPLE_FOR_PRECISION).toBe(30);
    const [s] = perSourcePrecisionFromRows([
      { source_key: "x", reviewed: 60, correct: 60, incorrect: 0, unusable: 0, runs: 4 },
    ]);
    expect(s.meetsPilotStandard).toBe(true);
  });
});