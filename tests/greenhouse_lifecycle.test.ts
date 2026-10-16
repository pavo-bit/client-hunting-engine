/**
 * Phase 4 / Workstream C: Greenhouse posting lifecycle integrity.
 *
 * The defect under test: an EDITED posting changed `updated_at`, which changed
 * the content hash, which appended a second ACTIVE hiring claim. Two countable
 * signals for one requisition is a correctness failure, not a duplicate-avoid
 * nicety.
 *
 * The rules proved here:
 *   1. first ingestion creates exactly one active signal;
 *   2. unchanged re-ingestion writes nothing;
 *   3. an edited posting appends history but leaves ONE active signal;
 *   4. an `updated_at`-only edit does not produce a second active signal;
 *   5. two distinct posting ids with identical text stay distinct;
 *   6. an interrupted write (claim persisted, record not) is repaired without
 *      a duplicate signal;
 *   7. an unlinked board token still performs no network call and no write;
 *   8. audit / snapshot / source-permission invariants hold throughout.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
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

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
process.env.DATABASE_URL = DB_URL;
const pool = new Pool({ connectionString: DB_URL, max: 4 });

const ACTOR = "p4life";
/** Reassigned per case so each test owns a fresh board token (and company). */
let BOARD = "life-board";
let seq = 0;
const okHeaders = { "content-type": "application/json" };

let fetchCalls = 0;
function registry(pages: unknown[]): AdapterRegistry {
  let i = 0;
  const r = new AdapterRegistry();
  r.register(
    new GreenhouseAdapter({
      fetchImpl: (async () => {
        fetchCalls += 1;
        const body = pages[Math.min(i, pages.length - 1)];
        i += 1;
        return new Response(JSON.stringify(body), { status: 200, headers: okHeaders });
      }) as unknown as typeof fetch,
    }),
  );
  return r;
}

const posting = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  title: "Senior Engineer",
  location: { name: "Remote" },
  requisition_id: "R-1",
  first_published: "2026-01-01T00:00:00Z",
  updated_at: "2026-02-01T00:00:00Z",
  absolute_url: `https://job-boards.greenhouse.io/${BOARD}/jobs/${id}?gh_jid=${id}`,
  ...over,
});
const boardOf = (jobs: unknown[]) => ({ jobs, meta: { total: jobs.length } });

async function cleanup(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("delete from public.discovery_record where source_key = $1", [SIGNAL_SOURCE_KEY]);
    await c.query(
      "delete from public.claim where company_id in (select id from public.company where domain_norm like 'p4l-%')",
    );
    await c.query(
      "delete from public.snapshot where company_id in (select id from public.company where domain_norm like 'p4l-%')",
    );
    await c.query("delete from public.company where domain_norm like 'p4l-%'");
    await c.query("delete from public.discovery_run where created_by = $1", [ACTOR]);
  } finally {
    c.release();
  }
}

async function seedCompany(tag: string): Promise<string> {
  const co = await createCompany(
    pool,
    {
      name: `P4l ${tag} Ltd`,
      domain: `p4l-${tag}-${Date.now()}.example`,
      agencyType: "web_development",
      country: "Sweden",
    },
    ACTOR,
  );
  return co.companyId;
}

async function activeHiringClaims(companyId: string): Promise<number> {
  const r = await pool.query(
    `select count(*)::int n from public.claim c join public.snapshot s on s.id = c.snapshot_id
      where c.company_id = $1 and c.predicate = 'hiring' and c.claim_status = 'observed'`,
    [companyId],
  );
  return r.rows[0].n;
}

async function totalSnapshots(companyId: string): Promise<number> {
  const r = await pool.query(
    "select count(*)::int n from public.snapshot where company_id = $1",
    [companyId],
  );
  return r.rows[0].n;
}

beforeAll(async () => {
  await cleanup();
  await pool.query("update public.source set enabled = true where key = $1", [SIGNAL_SOURCE_KEY]);
});

// Each case gets a clean slate AND its own board token: linkBoardToken
// deliberately refuses to re-point a token at another company, so sharing one
// token across cases would test the conflict path instead of the lifecycle.
beforeEach(async () => {
  await cleanup();
  seq += 1;
  BOARD = `life-board-${seq}`;
});

afterAll(async () => {
  await cleanup();
  await pool.query("update public.source set enabled = false where key = $1", [SIGNAL_SOURCE_KEY]);
  await pool.end();
});

describe("C1/C2: posting identity and version lifecycle", () => {
  it("1: first ingestion creates exactly one active signal", async () => {
    const companyId = await seedCompany("first");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });
    const run = await runSignalSource(pool, registry([boardOf([posting(101)])]), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    expect(run.status).toBe("ok");
    expect(run.counts.new).toBe(1);
    expect(run.items[0].status).toBe("new");
    expect(await activeHiringClaims(companyId)).toBe(1);
    expect(await totalSnapshots(companyId)).toBe(1);
  });

  it("2: re-ingesting an unchanged posting writes nothing", async () => {
    const companyId = await seedCompany("same");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });
    const reg = registry([boardOf([posting(102)])]);
    await runSignalSource(pool, reg, {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    const second = await runSignalSource(pool, reg, {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    expect(second.counts).toMatchObject({ found: 1, new: 0, updated: 0, unchanged: 1 });
    expect(second.items[0].status).toBe("unchanged");
    expect(await activeHiringClaims(companyId)).toBe(1);
    expect(await totalSnapshots(companyId)).toBe(1);
  });

  it("3: an edited posting keeps history but leaves ONE active signal", async () => {
    const companyId = await seedCompany("edited");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });
    await runSignalSource(pool, registry([boardOf([posting(103)])]), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });

    // The employer edits the posting (new title AND new updated_at).
    const edited = posting(103, {
      title: "Senior Engineer (Remote, Berlin)",
      updated_at: "2026-09-09T09:00:00Z",
    });
    const run = await runSignalSource(pool, registry([boardOf([edited])]), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    expect(run.counts.updated).toBe(1);
    expect(run.items[0].status).toBe("updated");
    expect(run.items[0].note).toMatch(/superseded/);

    // Exactly ONE active hiring signal remains...
    expect(await activeHiringClaims(companyId)).toBe(1);
    // ...while the previous observation is preserved, not destroyed.
    expect(await totalSnapshots(companyId)).toBe(2);
    const claims = await pool.query(
      `select c.claim_status, c.claim_text from public.claim c
         join public.snapshot s on s.id = c.snapshot_id
        where c.company_id = $1 order by c.created_at`,
      [companyId],
    );
    expect(claims.rows.map((r) => r.claim_status).sort()).toEqual(["observed", "superseded"]);
    // The current claim carries the NEW title; the superseded one the old.
    expect(claims.rows.find((r) => r.claim_status === "observed").claim_text).toMatch(/Berlin/);
    expect(claims.rows.find((r) => r.claim_status === "superseded").claim_text).not.toMatch(/Berlin/);

    // The supersession is audited.
    const audit = await pool.query(
      `select transition_from, transition_to from public.audit_log
        where entity_type = 'claim' and transition_to = 'superseded'
          and entity_id = $1`,
      [claims.rows.find((r) => r.claim_status === "superseded").claim_text ? (await pool.query(
        `select id from public.claim where company_id = $1 and claim_status = 'superseded'`, [companyId],
      )).rows[0].id : ""],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].transition_from).toBe("observed");

    // A third run with the edited content is now simply unchanged.
    const third = await runSignalSource(pool, registry([boardOf([edited])]), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    expect(third.counts).toMatchObject({ new: 0, updated: 0, unchanged: 1 });
    expect(await activeHiringClaims(companyId)).toBe(1);
  });

  it("4: an updated_at-only edit does not create a second active signal", async () => {
    const companyId = await seedCompany("tsonly");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });
    await runSignalSource(pool, registry([boardOf([posting(104)])]), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    const touched = posting(104, { updated_at: "2026-10-10T10:10:10Z" });
    const run = await runSignalSource(pool, registry([boardOf([touched])]), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    expect(run.counts.updated).toBe(1);
    // Same posting id, same title, same URL -> one active signal, two snapshots.
    expect(await activeHiringClaims(companyId)).toBe(1);
    expect(await totalSnapshots(companyId)).toBe(2);
  });

  it("5: two distinct posting ids with identical text stay distinct", async () => {
    const companyId = await seedCompany("twins");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });
    const run = await runSignalSource(pool, registry([boardOf([posting(201), posting(202)])]), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    expect(run.counts.new).toBe(2);
    // Identical titles, different ids and URLs -> two independent signals.
    expect(await activeHiringClaims(companyId)).toBe(2);
    // Exclude the bare board-token LINK row; we want the job records.
    const ids = await pool.query(
      "select source_record_id from public.discovery_record where source_key = $1 and company_id = $2 and source_record_id <> $3",
      [SIGNAL_SOURCE_KEY, companyId, BOARD],
    );
    expect(ids.rows.map((r) => r.source_record_id).sort()).toEqual([
      `${BOARD}:201`, `${BOARD}:202`,
    ]);

    // Editing ONE of them must not supersede the other.
    await runSignalSource(pool, registry([boardOf([posting(201, { updated_at: "2026-10-11T00:00:00Z" }), posting(202)])]), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    expect(await activeHiringClaims(companyId)).toBe(2);
  });

  it("6: an interrupted write is repaired without a duplicate signal", async () => {
    const companyId = await seedCompany("interrupted");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });
    await runSignalSource(pool, registry([boardOf([posting(301)])]), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    // Simulate a crash AFTER the observation was written but BEFORE the
    // discovery_record row was committed.
    await pool.query(
      "delete from public.discovery_record where source_key = $1 and source_record_id = $2",
      [SIGNAL_SOURCE_KEY, `${BOARD}:301`],
    );
    const repair = await runSignalSource(pool, registry([boardOf([posting(301)])]), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    // The observation already existed, so it is NOT counted as new, and no
    // second signal appears.
    expect(repair.counts.new).toBe(0);
    expect(await activeHiringClaims(companyId)).toBe(1);
    expect(await totalSnapshots(companyId)).toBe(1);
    const rec = await pool.query(
      "select count(*)::int n from public.discovery_record where source_key = $1 and source_record_id = $2",
      [SIGNAL_SOURCE_KEY, `${BOARD}:301`],
    );
    expect(rec.rows[0].n).toBe(1);
  });

  it("7: an unlinked board token performs no network call and no write", async () => {
    fetchCalls = 0;
    const run = await runSignalSource(pool, registry([boardOf([posting(401)])]), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: "unlinked-board-xyz", actor: ACTOR,
    });
    expect(run.status).toBe("unresolved");
    expect(run.companyId).toBeNull();
    expect(run.counts.found).toBe(0);
    // Identity is resolved BEFORE the fetch, so the source was never contacted.
    expect(fetchCalls).toBe(0);
    const writes = await pool.query(
      "select count(*)::int n from public.discovery_record where query_text = 'unlinked-board-xyz'",
    );
    expect(writes.rows[0].n).toBe(0);
  });

  it("8: source permission and provenance invariants hold across the lifecycle", async () => {
    const companyId = await seedCompany("perms");
    await linkBoardToken(pool, { companyId, boardToken: BOARD, actor: ACTOR });
    await runSignalSource(pool, registry([boardOf([posting(501)])]), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    // Provenance retained: source key and the original posting URL.
    const snap = await pool.query(
      "select source_key, url, sha256, retention_class from public.snapshot where company_id = $1",
      [companyId],
    );
    expect(snap.rows[0].source_key).toBe(SIGNAL_SOURCE_KEY);
    expect(snap.rows[0].url).toBe(`https://job-boards.greenhouse.io/${BOARD}/jobs/501?gh_jid=501`);
    expect(snap.rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    // Permission gate: disabling the source stops ingestion immediately.
    await pool.query("update public.source set enabled = false where key = $1", [SIGNAL_SOURCE_KEY]);
    const blocked = await runSignalSource(pool, registry([boardOf([posting(502)])]), {
      adapterId: GREENHOUSE_ADAPTER_ID, queryText: BOARD, actor: ACTOR, limit: 25,
    });
    expect(blocked.status).toBe("failed");
    expect(blocked.error).toMatch(/source_disabled/);
    expect(await activeHiringClaims(companyId)).toBe(1);
    await pool.query("update public.source set enabled = true where key = $1", [SIGNAL_SOURCE_KEY]);
    // The audit trail is append-only across the whole lifecycle.
    const audits = await pool.query(
      "select count(*)::int n from public.audit_log where entity_type = 'claim' and actor = $1",
      [ACTOR],
    );
    expect(audits.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});