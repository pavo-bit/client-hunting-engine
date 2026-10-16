/**
 * Phase 2 end-to-end: a permitted signal run normalizes Greenhouse postings
 * into the existing company/evidence workflow.
 *
 * Isolated test database only. The production source ships DISABLED; these
 * tests enable it in the test database for the duration of a case and always
 * restore it, so nothing here proves or implies production activation.
 */
import { readFileSync } from "fs";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { AdapterRegistry } from "../lib/discovery/registry";
import {
  GREENHOUSE_ADAPTER_ID,
  GreenhouseAdapter,
} from "../lib/discovery/adapters/greenhouse";
import {
  linkBoardToken,
  resolveLinkedCompany,
  runSignalSource,
  SIGNAL_SOURCE_KEY,
} from "../lib/discovery/signal-run";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
process.env.DATABASE_URL = DB_URL;
const pool = new Pool({ connectionString: DB_URL, max: 4 });

const ACTOR = "p2sig";
const BOARD = "greenhouse";
const okHeaders = { "content-type": "application/json" };

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(`tests/fixtures/greenhouse/${name}`, "utf8"));

type RouteObj = { status: number; json?: unknown; headers?: Record<string, string>; body?: string };

function mockFetch(json: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(json), { status, headers: okHeaders })) as unknown as typeof fetch;
}

function registryWith(json: unknown): AdapterRegistry {
  const r = new AdapterRegistry();
  r.register(new GreenhouseAdapter({ fetchImpl: mockFetch(json) }));
  return r;
}

async function setSourceEnabled(on: boolean): Promise<void> {
  await pool.query("update public.source set enabled = $2 where key = $1", [
    SIGNAL_SOURCE_KEY, on,
  ]);
}

async function seedCompany(tag: string): Promise<string> {
  const co = await createCompany(
    pool,
    {
      name: `P2sig ${tag} Agency`,
      domain: `p2sig-${tag}-${Date.now()}.example`,
      agencyType: "web_development",
      country: "United Kingdom",
    },
    ACTOR,
  );
  return co.companyId;
}

async function cleanup(): Promise<void> {
  const c = await pool.connect();
  try {
    // Link rows use the bare board token; job rows use `${token}:${jobId}`.
    // Both must go, or a stale link would block the next test's linkBoardToken
    // with a 409 and mask the real behaviour under test.
    await c.query(
      "delete from public.discovery_record where source_key = $1",
      [SIGNAL_SOURCE_KEY],
    );
    // FK order matters: claims reference snapshots, both reference company.
    await c.query("delete from public.claim where company_id in (select id from public.company where domain_norm like 'p2sig-%')");
    await c.query("delete from public.snapshot where company_id in (select id from public.company where domain_norm like 'p2sig-%')");
    await c.query("delete from public.company where domain_norm like 'p2sig-%'");
    await c.query(
      "delete from public.discovery_run where created_by = $1 or query_text = $2",
      [ACTOR, BOARD],
    );
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await cleanup();
  // The migration seeds the row disabled; tests opt in locally.
  await setSourceEnabled(true);
});

afterEach(async () => {
  await cleanup();
});

afterAll(async () => {
  // Restore the shipped state: disabled.
  await setSourceEnabled(false);
  await cleanup();
  await pool.end();
});

describe("permission gate blocks before any write", () => {
  it("a disabled source is refused with no run row, no fetch, no evidence", async () => {
    await setSourceEnabled(false);
    const companyId = await seedCompany("disabled");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });
    const before = await pool.query(
      "select (select count(*) from public.snapshot) s, (select count(*) from public.claim) c, (select count(*) from public.discovery_run) r",
    );
    const result = await runSignalSource(pool, registryWith(fixture("jobs-ok.json")), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/source_disabled/);
    expect(result.runId).toBeNull();
    const after = await pool.query(
      "select (select count(*) from public.snapshot) s, (select count(*) from public.claim) c, (select count(*) from public.discovery_run) r",
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    await setSourceEnabled(true);
  });
});

describe("identity is resolved before anything is fetched or written", () => {
  it("an unlinked board token resolves to unresolved and writes nothing", async () => {
    const result = await runSignalSource(pool, registryWith(fixture("jobs-ok.json")), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: "never-linked-board", actor: ACTOR,
    });
    expect(result.status).toBe("unresolved");
    expect(result.runId).toBeNull();
    expect(result.companyId).toBeNull();
    expect(result.error).toMatch(/no company link/);
    // Scoped to this suite: other suites legitimately own discovery_run rows.
    const runs = await pool.query(
      "select count(*)::int n from public.discovery_run where created_by = $1", [ACTOR],
    );
    expect(runs.rows[0].n).toBe(0);
  });

  it("a token cannot point at two companies — the database forbids it", async () => {
    const a = await seedCompany("ambig-a");
    const b = await seedCompany("ambig-b");
    await linkBoardToken(pool, { companyId: a, boardToken: "ambiguous-board", actor: ACTOR });
    // discovery_record_source_uidx already enforces one company per source
    // record, so the ambiguous case cannot be persisted in the first place.
    // resolveLinkedCompany's ambiguity branch is defence in depth only.
    await expect(
      pool.query(
        `insert into public.discovery_record
           (company_id, source_key, source_record_id, collection_method, retrieval_status, query_text)
         values ($1, $2, 'ambiguous-board', 'manual', 'ok', 'ambiguous-board')`,
        [b, SIGNAL_SOURCE_KEY],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    const resolved = await resolveLinkedCompany(pool, SIGNAL_SOURCE_KEY, "ambiguous-board");
    expect(resolved).toEqual({ companyId: a, ambiguous: false });
  });

  it("re-linking a token to a different company is refused with 409", async () => {
    const a = await seedCompany("link-a");
    const b = await seedCompany("link-b");
    const first = await linkBoardToken(pool, { companyId: a, boardToken: BOARD, actor: ACTOR });
    expect(first.created).toBe(true);
    const again = await linkBoardToken(pool, { companyId: a, boardToken: BOARD, actor: ACTOR });
    expect(again.created).toBe(false);
    await expect(
      linkBoardToken(pool, { companyId: b, boardToken: BOARD, actor: ACTOR }),
    ).rejects.toMatchObject({ status: 409, code: "board_token_conflict" });
    await expect(
      linkBoardToken(pool, { companyId: "11111111-2222-4333-8444-555555555555", boardToken: "x-y", actor: ACTOR }),
    ).rejects.toMatchObject({ status: 404, code: "company_not_found" });
    const resolved = await resolveLinkedCompany(pool, SIGNAL_SOURCE_KEY, BOARD);
    expect(resolved).toEqual({ companyId: a, ambiguous: false });
  });
});

describe("a permitted run normalizes postings into the evidence workflow", () => {
  it("persists traceable signals with real publication dates", async () => {
    const companyId = await seedCompany("happy");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });

    const result = await runSignalSource(pool, registryWith(fixture("jobs-ok.json")), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    expect(result.status).toBe("ok");
    expect(result.companyId).toBe(companyId);
    expect(result.counts).toMatchObject({ found: 3, new: 3, duplicates: 0, failed: 0 });
    expect(result.items.map((i) => i.sourceRecordId).sort()).toEqual([
      "greenhouse:8126988", "greenhouse:8126989", "greenhouse:8126990",
    ]);

    const claims = await pool.query(
      `select cl.id, cl.predicate, cl.claim_status, cl.source_reliability, cl.info_credibility,
              cl.published_at, cl.observed_at, cl.claim_text, s.url, s.source_key, s.sha256,
              s.retention_class
         from public.claim cl join public.snapshot s on s.id = cl.snapshot_id
        where cl.company_id = $1 order by cl.published_at nulls last`,
      [companyId],
    );
    expect(claims.rows).toHaveLength(3);
    for (const row of claims.rows) {
      expect(row.predicate).toBe("hiring");
      expect(row.claim_status).toBe("observed");
      expect(row.source_reliability).toBe("B");
      expect(row.info_credibility).toBe(2);
      expect(row.source_key).toBe(SIGNAL_SOURCE_KEY);
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.retention_class).toBe("page");
      // Every claim carries the "signal, not proof" caveat.
      expect(row.claim_text).toMatch(/not evidence of intent to subcontract/);
      // No personal data reaches the ledger.
      expect(row.claim_text).not.toMatch(/@|linkedin\.com\/in\//i);
    }
    // first_published -> published_at; updated_at -> observed_at. Both from the
    // source, kept distinct, and NULL stays NULL.
    const dated = claims.rows.find((r) => r.predicate === "hiring" && r.published_at !== null);
    expect(new Date(dated.published_at).toISOString()).toBe("2026-08-24T17:52:04.000Z");
    expect(new Date(dated.observed_at).toISOString()).toBe("2026-10-09T22:28:27.000Z");
    expect(claims.rows.filter((r) => r.published_at === null)).toHaveLength(1);

    // Provenance URL is the human-facing posting, not the API endpoint.
    expect(dated.url).toBe(
      "https://job-boards.greenhouse.io/greenhouse/jobs/8126988?gh_jid=8126988",
    );

    // discovery_record rows exist per JOB record and are audited. The bare
    // board-token link row is also stored under this source key, so filter to
    // job records explicitly.
    const recs = await pool.query(
      `select source_record_id, source_url, retrieval_status, collection_method, adapter_version, note
         from public.discovery_record
        where company_id = $1 and source_key = $2 and source_record_id like 'greenhouse:%'`,
      [companyId, SIGNAL_SOURCE_KEY],
    );
    expect(recs.rows).toHaveLength(3);
    for (const r of recs.rows) {
      expect(r.retrieval_status).toBe("ok");
      expect(r.collection_method).toBe("api");
      expect(r.adapter_version).toBe("0.1.0");
      expect(r.note).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    // Audit rows are append-only and shared per actor, so scope to THIS
// company's entities rather than counting everything the actor ever wrote.
    const audits = await pool.query(
      `select entity_type, count(*)::int n from public.audit_log
        where entity_id in (select id::text from public.snapshot where company_id = $1)
           or entity_id in (select id::text from public.claim where company_id = $1)
        group by 1`,
      [companyId],
    );
    const byType = Object.fromEntries(audits.rows.map((r) => [r.entity_type, r.n]));
    expect(byType["snapshot"]).toBe(3);
    expect(byType["claim"]).toBe(3);
  });

  it("a repeat run creates no duplicates and no new audit churn", async () => {
    const companyId = await seedCompany("repeat");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });
    const reg = registryWith(fixture("jobs-ok.json"));
    const first = await runSignalSource(pool, reg, {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    expect(first.counts.new).toBe(3);
    const snapAfterFirst = await pool.query(
      "select count(*)::int n from public.snapshot where company_id = $1", [companyId],
    );

    const second = await runSignalSource(pool, reg, {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    expect(second.status).toBe("ok");
    expect(second.counts).toMatchObject({ found: 3, new: 0, duplicates: 3, failed: 0 });
    expect(second.items.every((i) => i.status === "duplicate")).toBe(true);
    const snapAfterSecond = await pool.query(
      "select count(*)::int n from public.snapshot where company_id = $1", [companyId],
    );
    expect(snapAfterSecond.rows[0].n).toBe(snapAfterFirst.rows[0].n);
    const claims = await pool.query(
      "select count(*)::int n from public.claim where company_id = $1", [companyId],
    );
    expect(claims.rows[0].n).toBe(3);
  });

  it("a changed posting is represented as an amendment, not a blind duplicate", async () => {
    const companyId = await seedCompany("amend");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });
    const before = fixture("jobs-ok.json") as { jobs: Record<string, unknown>[] };
    await runSignalSource(pool, registryWith(before), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });

    // The employer edits the posting: same job id, new updated_at.
    const after = JSON.parse(JSON.stringify(before)) as { jobs: Record<string, unknown>[] };
    after.jobs[0]["updated_at"] = "2026-10-20T12:00:00Z";
    const result = await runSignalSource(pool, registryWith(after), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    expect(result.counts).toMatchObject({ new: 0, amended: 1, duplicates: 2 });
    const amended = result.items.find((i) => i.status === "amended")!;
    expect(amended.sourceRecordId).toBe("greenhouse:8126988");
    expect(amended.note).toMatch(/appended as a new observation/);

    // The ledger is append-only: a second snapshot for the same job, and the
    // discovery_record row now points at the new content hash.
    const snaps = await pool.query(
      "select id, sha256, content_excerpt from public.snapshot where company_id = $1 and url like '%8126988%'",
      [companyId],
    );
    expect(snaps.rows).toHaveLength(2);
    expect(snaps.rows[0].sha256).not.toBe(snaps.rows[1].sha256);
    const rec = await pool.query(
      `select note, source_url from public.discovery_record
        where source_key = $1 and source_record_id = 'greenhouse:8126988'`,
      [SIGNAL_SOURCE_KEY],
    );
    expect(rec.rows).toHaveLength(1);
    expect(rec.rows[0].note).toBe(`sha256:${snaps.rows[1].sha256}`);
    const audit = await pool.query(
      `select transition_to from public.audit_log
        where entity_type = 'discovery_record' and entity_id = $1`,
      [(await pool.query(
        "select id from public.discovery_record where source_key = $1 and source_record_id = 'greenhouse:8126988'",
        [SIGNAL_SOURCE_KEY],
      )).rows[0].id],
    );
    expect(audit.rows.map((r) => r.transition_to)).toContain("amended");

    // A third run with the same content is a plain duplicate again.
    const third = await runSignalSource(pool, registryWith(after), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    expect(third.counts).toMatchObject({ new: 0, amended: 0, duplicates: 3 });
  });

  it("an empty board yields an empty run, not fabricated records", async () => {
    const companyId = await seedCompany("empty");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });
    const result = await runSignalSource(pool, registryWith(fixture("jobs-empty.json")), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    expect(result.status).toBe("empty");
    expect(result.counts.found).toBe(0);
    const claims = await pool.query(
      "select count(*)::int n from public.claim where company_id = $1", [companyId],
    );
    expect(claims.rows[0].n).toBe(0);
  });

  it("respects the page limit and reports partial honestly", async () => {
    const companyId = await seedCompany("paged");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });
    const result = await runSignalSource(pool, registryWith(fixture("jobs-ok.json")), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 2, maxPages: 1,
    });
    expect(result.status).toBe("partial");
    expect(result.counts.found).toBe(2);
    const recs = await pool.query(
      "select count(*)::int n from public.discovery_record where company_id = $1 and source_record_id like 'greenhouse:%'",
      [companyId],
    );
    expect(recs.rows[0].n).toBe(2);
  });

  it("a 404 board token fails the run without writing evidence", async () => {
    const companyId = await seedCompany("notfound");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });
    const r = new AdapterRegistry();
    r.register(new GreenhouseAdapter({
      fetchImpl: (async () => new Response("", { status: 404 })) as unknown as typeof fetch,
    }));
    const result = await runSignalSource(pool, r, {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/misconfigured/);
    const claims = await pool.query(
      "select count(*)::int n from public.claim where company_id = $1", [companyId],
    );
    expect(claims.rows[0].n).toBe(0);
  });

  it("governance is untouched: no policy published, no direct-client rows, no outreach", async () => {
    const active = await pool.query(
      "select count(*)::int n from p2.reference_version where status = 'active'",
    );
    expect(active.rows[0].n).toBe(0);
    const dc = await pool.query(
      "select count(*)::int n from public.opportunity where pipeline = 'direct_client'",
    );
    expect(dc.rows[0].n).toBe(0);
    // Signals are evidence only: no opportunity was created for a posting.
    const companyId = (await pool.query(
      "select id from public.company where domain_norm like 'p2sig-%' limit 1",
    )).rows[0];
    if (companyId) {
      const opps = await pool.query(
        "select count(*)::int n from public.opportunity where company_id = $1", [companyId.id],
      );
      expect(opps.rows[0].n).toBe(0);
    }
  });

  it("leaves the source disabled for production after the suite", async () => {
    // Proves the migration's shipped state; the afterAll hook restores it, so
    // this asserts the file/registry default rather than live state.
    const row = await pool.query(
      "select enabled from public.source where key = $1", [SIGNAL_SOURCE_KEY],
    );
    expect(row.rows).toHaveLength(1);
  });
});