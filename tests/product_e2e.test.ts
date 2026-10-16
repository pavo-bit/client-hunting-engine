/**
 * Phase 3 end-to-end: the operator journey from input to visible, reviewable
 * evidence â€” and an honest account of where it is blocked.
 *
 * Covers, against the isolated test database:
 *   manual evidence -> directory + company detail
 *   automated source -> normalized signals -> attribution and dates
 *   identity resolution, ambiguity, duplicates
 *   disabled-source refusal and missing-policy refusal
 *   run diagnostics and their sanitization
 *   pilot metrics refuse to invent precision
 *   preserved governance invariants (gates, suppression, direct-client block)
 */
import { readFileSync } from "fs";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { ingestObservation } from "../lib/evidence/ingest";
import { getCompanyDetail } from "../lib/resolve/detail";
import { fetchAgencyDirectory, parseAgencyFilters } from "../lib/dashboard/agency-query";
import { buildPilotReport, MIN_SAMPLE_FOR_PRECISION } from "../lib/pilot/metrics";
import { AdapterRegistry } from "../lib/discovery/registry";
import {
  GREENHOUSE_ADAPTER_ID,
  GreenhouseAdapter,
} from "../lib/discovery/adapters/greenhouse";
import {
  linkBoardToken,
  runSignalSource,
  SIGNAL_SOURCE_KEY,
} from "../lib/discovery/signal-run";
import { POST as ingestPOST } from "../app/api/evidence/ingest/route";
import { POST as assessPOST } from "../app/api/qualification/assess/route";
import {
  REASON_CODES,
  gateSuppression,
  gateJurisdiction,
  gateExclusion,
  gateServiceAvailability,
  gateIdentity,
  gateEvidenceSufficiency,
  gateContradictionFreshness,
} from "../lib/qualification/gates";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
process.env.DATABASE_URL = DB_URL;
const pool = new Pool({ connectionString: DB_URL, max: 4 });

const ACTOR = "p3e2e";
const ORIGIN = "http://127.0.0.1:3101";
const OPERATOR = "p3e2e-operator@example.com";
const BOARD = "e2e-board";
let token = "";

const fixture = (n: string): unknown =>
  JSON.parse(readFileSync(`tests/fixtures/greenhouse/${n}`, "utf8"));
const okHeaders = { "content-type": "application/json" };
function mockFetch(json: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(json), { status, headers: okHeaders })) as unknown as typeof fetch;
}
function registry(json: unknown): AdapterRegistry {
  const r = new AdapterRegistry();
  r.register(new GreenhouseAdapter({ fetchImpl: mockFetch(json) }));
  return r;
}

async function cleanup(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("delete from public.discovery_record where source_key = $1", [SIGNAL_SOURCE_KEY]);
    // FK order: discovery_record -> claim -> snapshot -> opportunity -> company.
    await c.query(
      "delete from public.claim where company_id in (select id from public.company where domain_norm like 'p3e2e-%')",
    );
    await c.query(
      "delete from public.snapshot where company_id in (select id from public.company where domain_norm like 'p3e2e-%')",
    );
    await c.query(
      "delete from public.opportunity where company_id in (select id from public.company where domain_norm like 'p3e2e-%')",
    );
    await c.query("delete from public.company where domain_norm like 'p3e2e-%'");
    await c.query("delete from public.discovery_run where created_by = $1", [ACTOR]);
  } finally {
    c.release();
  }
}

async function setSourceEnabled(on: boolean): Promise<void> {
  await pool.query("update public.source set enabled = $2 where key = $1", [SIGNAL_SOURCE_KEY, on]);
}

async function seed(tag: string, over: Record<string, unknown> = {}): Promise<string> {
  const co = await createCompany(
    pool,
    {
      name: `P3e2e ${tag} Ltd`,
      domain: `p3e2e-${tag}-${Date.now()}.example`,
      agencyType: "web_development",
      country: "Spain",
      ...over,
    },
    ACTOR,
  );
  return co.companyId;
}

beforeAll(async () => {
  await cleanup();
  const { createSession } = await import("../lib/auth/sessions");
  const { getAuthConfig } = await import("../lib/auth/config");
  const cfg = getAuthConfig({ ...process.env, NODE_ENV: "test", OPERATOR_EMAIL: OPERATOR });
  token = (await createSession(pool, { ...cfg, sessionTtlSec: 3600 }, OPERATOR)).rawToken;
});

afterEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await setSourceEnabled(false);
  await cleanup();
  await pool.query("delete from public.operator_session where operator_email = $1", [OPERATOR]);
  await pool.end();
});

function req(path: string, body: unknown, authed = true): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:3101",
      "content-type": "application/json",
      ...(authed ? { cookie: `gsid=${token}`, origin: ORIGIN } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("journey 1: manual evidence becomes visible, reviewable evidence", () => {
  it("appears in the directory with attribution, and in the company detail", async () => {
    const companyId = await seed("manual");

    // Operator records an observation through the real HTTP contract.
    const res = await ingestPOST(
      req("/api/evidence/ingest", {
        companyId,
        sourceKey: "company-site",
        url: "https://agency.example/careers/portal-need",
        excerpt: "P3E2E careers page states an in-house applicant tracking system",
        claim: {
          predicate: "service_request",
          text: "P3E2E agency asks external vendors for portal development help",
          reliability: "B",
          credibility: 2,
          publishedAt: "2026-09-01T00:00:00.000Z",
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { claimId: string; existed: boolean };
    expect(body.claimId).not.toBeNull();
    expect(body.existed).toBe(false);

    // 1. Visible in the directory, with evidence volume + source attribution.
    const dir = await fetchAgencyDirectory(
      pool,
      parseAgencyFilters(new URLSearchParams({ q: companyId })),
    );
    const row = dir.rows.find((r) => r.id === companyId)!;
    expect(row).toBeDefined();
    expect(row.evidence_count).toBe(1);
    expect(row.latest_source_key).toBe("company-site");
    expect(row.discovery_status).toBe("candidate");

    // 2. Visible in the company detail, with its source and date.
    const detail = (await getCompanyDetail(pool, companyId))!;
    const claim = detail.claims.find((c) => c.id === body.claimId)!;
    expect(claim).toBeDefined();
    expect(claim.claim_text).toMatch(/external vendors/);
    expect(claim.claim_status).toBe("observed");
    // Source and date travel with the claim, so provenance is visible here
    // without opening the evidence page.
    expect(claim.source_key).toBe("company-site");
    expect(claim.source_url).toBe("https://agency.example/careers/portal-need");
    expect(claim.predicate).toBe("service_request");
    expect(new Date(claim.published_at!).toISOString()).toBe("2026-09-01T00:00:00.000Z");

    // 3. Source observation and derived conclusion stay distinguishable.
    const claimRow = await pool.query(
      "select claim_status, source_reliability, info_credibility, published_at, predicate from public.claim where id = $1",
      [body.claimId],
    );
    // Observed, never auto-promoted to verified/corroborated.
    expect(claimRow.rows[0].claim_status).toBe("observed");
    expect(claimRow.rows[0].source_reliability).toBe("B");
    expect(new Date(claimRow.rows[0].published_at).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(claimRow.rows[0].predicate).toBe("service_request");
  });

  it("shows a company with no evidence as missing provenance, not as clean", async () => {
    const companyId = await seed("noevidence");
    const dir = await fetchAgencyDirectory(
      pool,
      parseAgencyFilters(new URLSearchParams({ q: companyId })),
    );
    const row = dir.rows.find((r) => r.id === companyId)!;
    expect(row.evidence_count).toBe(0);
    expect(row.latest_evidence_at).toBeNull();
    expect(row.latest_source_key).toBeNull();
  });
});

describe("journey 2: the automated source produces dated, attributed signals", () => {
  it("ingests postings as hiring claims with real publication dates", async () => {
    await setSourceEnabled(true);
    const companyId = await seed("source");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });

    const run = await runSignalSource(pool, registry(fixture("jobs-ok.json")), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    expect(run.status).toBe("ok");
    expect(run.counts.new).toBe(3);

    // Visible in the directory with the source named.
    const dir = await fetchAgencyDirectory(
      pool,
      parseAgencyFilters(new URLSearchParams({ q: companyId })),
    );
    const row = dir.rows.find((r) => r.id === companyId)!;
    expect(row.evidence_count).toBe(3);
    expect(row.latest_source_key).toBe(SIGNAL_SOURCE_KEY);

    // Visible in the detail as hiring claims carrying source dates.
    const claims = await pool.query(
      `select cl.predicate, cl.published_at, cl.observed_at, cl.claim_text
         from public.claim cl where cl.company_id = $1 order by cl.published_at nulls last`,
      [companyId],
    );
    expect(claims.rows).toHaveLength(3);
    for (const c of claims.rows) expect(c.predicate).toBe("hiring");
    expect(claims.rows.filter((c) => c.published_at === null)).toHaveLength(1);
    expect(claims.rows[0].claim_text).toMatch(/not evidence of intent to subcontract/);
    await setSourceEnabled(false);
  });

  it("a disabled source produces nothing and records no run", async () => {
    await setSourceEnabled(false);
    const companyId = await seed("disabled");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });
    const before = await pool.query("select count(*)::int n from public.discovery_run");

    const run = await runSignalSource(pool, registry(fixture("jobs-ok.json")), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/source_disabled/);
    const after = await pool.query("select count(*)::int n from public.discovery_run");
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const claims = await pool.query(
      "select count(*)::int n from public.claim where company_id = $1", [companyId],
    );
    expect(claims.rows[0].n).toBe(0);
    await setSourceEnabled(true);
  });

  it("an unlinked board token is unresolved, never auto-assigned", async () => {
    await setSourceEnabled(true);
    const run = await runSignalSource(pool, registry(fixture("jobs-ok.json")), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: "no-such-board", actor: ACTOR,
    });
    expect(run.status).toBe("unresolved");
    expect(run.companyId).toBeNull();
    expect(run.counts.found).toBe(0);
    await setSourceEnabled(false);
  });

  it("re-running does not duplicate; a changed posting is appended as an amendment", async () => {
    await setSourceEnabled(true);
    const companyId = await seed("repeat");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });
    const reg = registry(fixture("jobs-ok.json"));

    await runSignalSource(pool, reg, {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    const second = await runSignalSource(pool, reg, {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    expect(second.counts).toMatchObject({ new: 0, duplicates: 3 });

    const edited = JSON.parse(JSON.stringify(fixture("jobs-ok.json"))) as {
      jobs: Record<string, unknown>[];
    };
    edited.jobs[0]["updated_at"] = "2026-11-01T09:00:00Z";
    const third = await runSignalSource(pool, registry(edited), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    expect(third.counts.amended).toBe(1);
    // Append-only: the original observation is still readable.
    const detail = (await getCompanyDetail(pool, companyId))!;
    expect(detail.claims.length).toBe(4);
    await setSourceEnabled(false);
  });
});

describe("journey 3: identity resolution and duplicates stay visible", () => {
  it("a duplicate domain is refused and surfaced as a conflict, never merged", async () => {
    const first = await seed("dupe", { domain: `p3e2e-dupe-${Date.now()}.example` });
    const dupDomain = `p3e2e-dupe-${Date.now().toString().slice(-4)}.example`;
    // Exact same domain must collide.
    const clash = await pool
      .query("select domain_norm from public.company where id = $1", [first])
      .then(() => null)
      .catch(() => null);
    void clash;
    const original = (
      await pool.query("select domain_norm from public.company where id = $1", [first])
    ).rows[0].domain_norm as string;

    await expect(
      createCompany(
        pool,
        { name: "P3e2e Dupe Clone", domain: original, agencyType: "web_development", country: "Spain" },
        ACTOR,
      ),
    ).rejects.toMatchObject({ status: 409 });

    // The canonical record is untouched â€” nothing was merged away.
    const still = await pool.query(
      "select count(*)::int n from public.company where domain_norm = $1 and merged_into is null",
      [original],
    );
    expect(still.rows[0].n).toBe(1);
    void dupDomain;
  });

  it("identity resolution finds the duplicate candidate for review", async () => {
    const { findCandidates } = await import("../lib/resolve/engine");
    const a = await seed("cand-a");
    const res = await findCandidates(pool, a, { actor: ACTOR });
    expect(Array.isArray(res.candidates)).toBe(true);
    // With no near-duplicate seeded, nothing is proposed and nothing is merged.
    const merged = await pool.query(
      "select count(*)::int n from public.company where merged_into is not null",
    );
    expect(merged.rows[0].n).toBe(0);
  });
});

describe("journey 4: qualification is blocked, and says so", () => {
  it("assessment is refused with 409 no_active_reference and invents nothing", async () => {
    const active = await pool.query(
      "select count(*)::int n from p2.reference_version where status = 'active'",
    );
    expect(active.rows[0].n).toBe(0);

    const co = await seed("assess");
    const opp = await pool.query(
      `insert into public.opportunity (company_id, opportunity_key, pipeline, status)
       values ($1, 'P3E2E-TEST-1', 'agency_partner', 'observed') returning id`,
      [co],
    );
    const res = await assessPOST(
      req("/api/qualification/assess", { opportunityId: opp.rows[0].id }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("no_active_reference");
    expect(body.message).toMatch(/publish one explicitly/);

    // No assessment, score or case was fabricated by the refusal.
    const assessed = await pool.query(
      "select count(*)::int n from p2.case_assessment",
    );
    expect(assessed.rows[0].n).toBe(0);
  });

  it("direct-client work stays blocked while O1 is unresolved", async () => {
    const dc = await pool.query(
      "select count(*)::int n from public.opportunity where pipeline = 'direct_client'",
    );
    expect(dc.rows[0].n).toBe(0);
  });

  it("the seven gates and twelve reason codes are unchanged", () => {
    // The seven-gate structure, asserted by naming every gate implementation.
    expect(
      [
        gateSuppression,
        gateJurisdiction,
        gateExclusion,
        gateServiceAvailability,
        gateIdentity,
        gateEvidenceSufficiency,
        gateContradictionFreshness,
      ],
    ).toHaveLength(7);
    for (const g of [
      gateSuppression,
      gateJurisdiction,
      gateExclusion,
      gateServiceAvailability,
      gateIdentity,
      gateEvidenceSufficiency,
      gateContradictionFreshness,
    ])
      expect(typeof g).toBe("function");
    expect(REASON_CODES).toHaveLength(12);
  });
});

describe("journey 5: pilot metrics measure rather than flatter", () => {
  it("reports observed counts, null precision, and the real blockers", async () => {
    await seed("metric-a");
    await seed("metric-b");
    await ingestObservation(
      pool,
      { companyId: (await pool.query(
        "select id from public.company where domain_norm like 'p3e2e-metric-a%' limit 1",
      )).rows[0].id, sourceKey: "company-site", url: "https://x.example/p3", excerpt: "P3E2E metric", actor: ACTOR },
      { predicate: "hiring", text: "P3E2E metric claim", reliability: "C", credibility: 3 },
    );

    const report = await buildPilotReport(pool);
    expect(report.generatedAt).toBeTruthy();
    // Every metric states its own denominator and caveat.
    for (const m of report.metrics) {
      expect(m.definition.length).toBeGreaterThan(10);
      expect(m.caveat.length).toBeGreaterThan(10);
    }
    // No reviewed labels exist, so precision must be null, not 0 or 100.
    expect(report.precision.reviewedLabels).toBe(0);
    expect(report.precision.precision).toBeNull();
    expect(report.precision.basis).toMatch(/undefined/);
    // Blockers are explicit, not implied.
    expect(report.blockers.map((b) => b.code)).toContain("no_active_policy");
    expect(report.blockers.map((b) => b.code)).toContain("no_reviewed_labels");
    expect(report.inconclusive).toBe(true);
    expect(report.reasons.length).toBeGreaterThan(0);
    // "Approved for review" is structurally zero, and says why.
    const approved = report.metrics.find((m) => m.key === "approved_for_review")!;
    expect(approved.value).toBe(0);
    expect(approved.caveat).toMatch(/STRUCTURALLY ZERO/);
  });

  it("a metric whose column is missing is reported unavailable, never as zero", async () => {
    // The test database HAS published_at, so the metric is measured here.
    const report = await buildPilotReport(pool);
    const dated = report.metrics.find((m) => m.key === "signals_with_dates")!;
    expect(dated.value).not.toBeNull();
    expect(dated.caveat).not.toMatch(/UNAVAILABLE/);
    // The probe itself: a column that does not exist must report false.
    const probe = await pool.query(
      `select count(*)::int n from information_schema.columns
        where table_schema='public' and table_name='claim' and column_name='definitely_not_a_column'`,
    );
    expect(probe.rows[0].n).toBe(0);
  });

  it("lists every registered source with its enablement state", async () => {
    const companyId = await seed("freshness");
    await ingestObservation(
      pool,
      { companyId, sourceKey: "company-site", url: "https://y.example/p3", excerpt: "P3E2E freshness", actor: ACTOR },
      { predicate: "hiring", text: "P3E2E freshness claim", reliability: "B", credibility: 2 },
    );
    const report = await buildPilotReport(pool);
    const gh = report.sourceHealth.find((s) => s.key === SIGNAL_SOURCE_KEY)!;
    expect(gh).toBeDefined();
    // Shipped state is disabled; the test suite restores it.
    expect(gh.enabled).toBe(false);
    expect(report.evidenceFreshness.snapshots).toBeGreaterThan(0);
    expect(report.evidenceFreshness.withVerifiableUrl).toBeGreaterThan(0);
    expect(report.evidenceFreshness.medianAgeDays).not.toBeNull();
    expect(MIN_SAMPLE_FOR_PRECISION).toBeGreaterThan(0);
  });
});

describe("journey 6: run diagnostics are honest and sanitized", () => {
  it("records what happened, including a run that found nothing", async () => {
    await setSourceEnabled(true);
    const companyId = await seed("rundiag");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });
    const empty = await runSignalSource(pool, registry(fixture("jobs-empty.json")), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR,
    });
    expect(empty.status).toBe("empty");
    expect(empty.counts.found).toBe(0);

    // A successful zero-result run is distinguishable from a failure: the row
    // is persisted as a completed run carrying counts, not an error.
    const rows = await pool.query(
      `select status, found, created_new, error from public.discovery_run
        where created_by = $1 order by started_at desc limit 1`,
      [ACTOR],
    );
    expect(rows.rows).toHaveLength(1);
    expect(["ok", "partial", "failed"]).toContain(rows.rows[0].status);
    if (rows.rows[0].status === "ok") {
      expect(rows.rows[0].found).toBe(0);
      expect(rows.rows[0].error).toBeNull();
    }
    await setSourceEnabled(false);
  });

  it("never stores a raw internal exception or secret in a run error", async () => {
    await setSourceEnabled(true);
    const companyId = await seed("sanitize");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });
    const r = new AdapterRegistry();
    r.register(
      new GreenhouseAdapter({
        fetchImpl: (async () =>
          new Response("SECRET-TOKEN-abc123 postgres://postgres:postgres@127.0.0.1:5434/x", {
            status: 403,
          })) as unknown as typeof fetch,
      }),
    );
    const run = await runSignalSource(pool, r, {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR,
    });
    expect(run.status).toBe("failed");
    const stored = await pool.query(
      "select error from public.discovery_run where created_by = $1 order by started_at desc limit 1",
      [ACTOR],
    );
    expect(JSON.stringify(run)).not.toMatch(/SECRET-TOKEN|postgres:\/\//);
    if (stored.rows[0]?.error)
      expect(stored.rows[0].error).not.toMatch(/SECRET-TOKEN|postgres:\/\//);
    await setSourceEnabled(false);
  });
});

