/**
 * F14: HTTP security + contract tests for the Discovery and opportunity API
 * routes.
 *
 * Five routes shipped in Prompt 5 had no route-level tests at all
 * (`GET /api/opportunities`, `GET /api/opportunities/[key]`,
 * `GET /api/discovery/refreshes/[id]`, `POST /api/discovery/refreshes`,
 * `POST /api/discovery/reap`). This file pins, for each of them:
 *   - anonymous access is refused with 401 and leaks no data,
 *   - cookie-authenticated mutations require a same-origin request (CSRF) and
 *     the guard fires BEFORE any write,
 *   - malformed input is a clean documented refusal, never a raw 500,
 *   - the response shape matches the published contract,
 *   - the collection has no total-opportunity cap (R5),
 *   - attribution comes from the session, never from the request body (F9).
 *
 * Everything runs offline against the isolated test database. No route under
 * test performs network access: the only adapter reachable through the
 * production registry is GLEIF, and no test here names it.
 */
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistry } from "../lib/discovery/registry";
import { AgencyDirectoryFixture } from "../lib/discovery/fixtures/agency-directory";
import { evaluateEligibility } from "../lib/discovery/eligibility";
import { registerOpportunity } from "../lib/discovery/opportunities";
import { refreshSummary, runRefresh } from "../lib/discovery/refresh";
import { GET as opportunitiesGET } from "../app/api/opportunities/route";
import { GET as opportunityGET } from "../app/api/opportunities/[key]/route";
import { GET as refreshGET } from "../app/api/discovery/refreshes/[id]/route";
import { POST as refreshPOST } from "../app/api/discovery/refreshes/route";
import { POST as reapPOST } from "../app/api/discovery/reap/route";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
process.env.DATABASE_URL = DB_URL;
const pool = new Pool({ connectionString: DB_URL, max: 4 });
const ORIGIN = "http://127.0.0.1:3101";
const HOST = "127.0.0.1:3101";
const OPERATOR = "f14-operator@example.com";
const ACTOR = "f14";

let token = "";

function req(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers: { host: HOST, ...(init.headers ?? {}) },
    body: init.body,
  });
}
/** Cookie-authenticated + same-origin (the shape a real browser sends). */
function authReq(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): NextRequest {
  return req(path, { ...init, headers: { cookie: `gsid=${token}`, origin: ORIGIN, ...(init.headers ?? {}) } });
}
function json(body: unknown): string {
  return JSON.stringify(body);
}

/** Data cleanup only. Sessions are minted once and must SURVIVE per-test
 *  cleanup - deleting them here revoked the operator mid-suite and every
 *  authenticated request afterwards answered 401. */
async function cleanup(): Promise<void> {
  const c = await pool.connect();
  try {
    // Opportunities first: `company` is RESTRICT-referenced by them. Both the
    // f14- keys and the fixture keys created by the in-suite refreshes.
    await c.query(
      `delete from public.opportunity
       where opportunity_key like 'opp:agency_partner:f14-%'
          or opportunity_key like 'opp:agency_partner:agency-directory:f14-%'
          or opportunity_key like 'opp:agency_partner:agency-directory:fixture-%'`,
    );
    await c.query(
      "delete from public.discovery_run where created_by = $1 or query_text like 'manual refresh:%'",
      [ACTOR],
    );
    await c.query("delete from public.company where domain_norm like 'fixture-%'");
  } finally {
    c.release();
  }
}

async function newStaleRun(): Promise<string> {
  const r = await pool.query(
    `insert into public.discovery_run (adapter_id, adapter_version, status, query_text, created_by, started_at)
     values ('f14-stale', '1', 'running', $1, $2, now() - interval '3 hours') returning id`,
    [`f14 stale run ${Date.now()}`, ACTOR],
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  await cleanup();
  const { createSession } = await import("../lib/auth/sessions");
  const { getAuthConfig } = await import("../lib/auth/config");
  const cfg = getAuthConfig({ ...process.env, NODE_ENV: "test", OPERATOR_EMAIL: OPERATOR });
  const s = await createSession(pool, { ...cfg, sessionTtlSec: 3600 }, OPERATOR);
  token = s.rawToken;
});

afterAll(async () => {
  await cleanup();
  // The minted session is torn down last, after all data cleanup.
  await pool.query("delete from public.operator_session where operator_email = $1", [OPERATOR]);
  await pool.end();
});

describe("R1: anonymous access is refused and leaks nothing", () => {
  it("GET /api/opportunities -> 401", async () => {
    const res = await opportunitiesGET(req("/api/opportunities"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "unauthorized", message: "authentication required" });
  });

  it("GET /api/opportunities/[key] -> 401", async () => {
    const key = encodeURIComponent("opp:agency_partner:agency-directory:x");
    const res = await opportunityGET(req(`/api/opportunities/${key}`), {
      params: Promise.resolve({ key }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthorized" });
  });

  it("GET /api/discovery/refreshes/[id] -> 401", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const res = await refreshGET(req(`/api/discovery/refreshes/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/discovery/refreshes -> 401 and no run row is created", async () => {
    const before = await pool.query(
      "select count(*)::int as n from public.discovery_run where query_text like 'f14-anon%'",
    );
    const res = await refreshPOST(
      req("/api/discovery/refreshes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: json({ tasks: [{ adapterId: "agency-directory-fixture", queryText: "f14-anon" }] }),
      }),
    );
    expect(res.status).toBe(401);
    const after = await pool.query(
      "select count(*)::int as n from public.discovery_run where query_text like 'f14-anon%'",
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("POST /api/discovery/reap -> 401 and no audit row is written", async () => {
    const runId = await newStaleRun();
    const res = await reapPOST(
      req("/api/discovery/reap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: json({ staleAfterMinutes: 60 }),
      }),
    );
    expect(res.status).toBe(401);
    const row = await pool.query("select status from public.discovery_run where id = $1", [runId]);
    expect(row.rows[0].status).toBe("running");
    await cleanup();
  });

  it("a wrong bearer credential is refused (no ambient authority)", async () => {
    const res = await opportunitiesGET(
      req("/api/opportunities", { headers: { authorization: "Bearer not-the-token" } }),
    );
    expect(res.status).toBe(401);
  });
});

describe("R2: mutations require a same-origin request (CSRF)", () => {
  it("POST /api/discovery/reap without Origin -> 403 and nothing is reaped", async () => {
    const runId = await newStaleRun();
    const res = await reapPOST(
      req("/api/discovery/reap", {
        method: "POST",
        headers: { cookie: `gsid=${token}`, "content-type": "application/json" },
        body: json({ staleAfterMinutes: 60 }),
      }),
    );
    // The session is valid, so this MUST be the CSRF guard (401 would prove
    // nothing about CSRF).
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "forbidden", message: "origin check failed" });
    const row = await pool.query("select status from public.discovery_run where id = $1", [runId]);
    expect(row.rows[0].status).toBe("running");
    await cleanup();
  });

  it("a cross-origin Origin header is refused too", async () => {
    const runId = await newStaleRun();
    const res = await reapPOST(
      req("/api/discovery/reap", {
        method: "POST",
        headers: {
          cookie: `gsid=${token}`,
          origin: "http://evil.example",
          "content-type": "application/json",
        },
        body: json({ staleAfterMinutes: 60 }),
      }),
    );
    expect(res.status).toBe(403);
    const row = await pool.query("select status from public.discovery_run where id = $1", [runId]);
    expect(row.rows[0].status).toBe("running");
    await cleanup();
  });

  it("the same request WITH a same-origin Origin proceeds (positive control)", async () => {
    const runId = await newStaleRun();
    const res = await reapPOST(
      authReq("/api/discovery/reap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: json({ staleAfterMinutes: 60, dryRun: false }),
      }),
    );
    expect(res.status).toBe(200);
    const row = await pool.query("select status from public.discovery_run where id = $1", [runId]);
    expect(row.rows[0].status).toBe("failed");
    await cleanup();
  });
});

describe("R3: malformed input is a clean refusal, never a 500", () => {
  it("GET /api/opportunities validates pipeline and clamps paging", async () => {
    const bad = await opportunitiesGET(authReq("/api/opportunities?pipeline=inventory"));
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: "bad_pipeline" });

    // limit is clamped into 1..200 and offset floored at 0 - no 500, no unbounded query.
    const big = await opportunitiesGET(authReq("/api/opportunities?limit=100000&offset=-5"));
    expect(big.status).toBe(200);
    const body = (await big.json()) as { limit: number; offset: number };
    expect(body.limit).toBe(200);
    expect(body.offset).toBe(0);

    // `limit=0` is falsy and falls back to the documented default (50) rather
    // than being honoured as a zero-page request.
    const zero = await opportunitiesGET(authReq("/api/opportunities?limit=0"));
    expect(zero.status).toBe(200);
    expect(((await zero.json()) as { limit: number }).limit).toBe(50);
  });

  it("GET /api/opportunities/[key] refuses an unknown pipeline and unknown keys", async () => {
    const key = encodeURIComponent("opp:agency_partner:f14-nope:x");
    const badPipeline = await opportunityGET(authReq(`/api/opportunities/${key}?pipeline=nope`), {
      params: Promise.resolve({ key }),
    });
    expect(badPipeline.status).toBe(422);
    expect(await badPipeline.json()).toMatchObject({ code: "bad_pipeline" });

    const missing = await opportunityGET(authReq(`/api/opportunities/${key}`), {
      params: Promise.resolve({ key }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "opportunity_not_found" });
  });

  it("GET /api/discovery/refreshes/[id] refuses a non-uuid and 404s an unknown uuid", async () => {
    const bad = await refreshGET(authReq("/api/discovery/refreshes/not-a-uuid"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: "bad_id" });

    const unknown = await refreshGET(
      authReq("/api/discovery/refreshes/11111111-2222-4333-8444-555555555555"),
      { params: Promise.resolve({ id: "11111111-2222-4333-8444-555555555555" }) },
    );
    expect(unknown.status).toBe(404);
  });

  it("POST /api/discovery/refreshes refuses a non-JSON body and a malformed plan", async () => {
    const notJson = await refreshPOST(
      authReq("/api/discovery/refreshes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "this is not json",
      }),
    );
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ code: "bad_json" });

    const noTasks = await refreshPOST(
      authReq("/api/discovery/refreshes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: json({ tasks: [] }),
      }),
    );
    expect(noTasks.status).toBe(422);
    expect(await noTasks.json()).toMatchObject({ code: "bad_plan" });

    const tooMany = await refreshPOST(
      authReq("/api/discovery/refreshes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: json({
          tasks: Array.from({ length: 26 }, (_, i) => ({ adapterId: "a", queryText: `q${i}` })),
        }),
      }),
    );
    expect(tooMany.status).toBe(422);

    // Stopping thresholds are explicit or absent - never defaulted.
    const badStop = await refreshPOST(
      authReq("/api/discovery/refreshes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: json({ tasks: [{ adapterId: "agency-directory-fixture", queryText: "f14-stop" }], stop: { lowYieldStreak: 0, concentrationCap: 2 } }),
      }),
    );
    expect(badStop.status).toBe(422);
    expect(await badStop.json()).toMatchObject({ code: "bad_stop_config" });
  });

  it("POST /api/discovery/reap requires an explicit, sane threshold", async () => {
    const notJson = await reapPOST(
      authReq("/api/discovery/reap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "nope",
      }),
    );
    expect(notJson.status).toBe(400);

    for (const value of [undefined, "abc", 0, -5, 99_999]) {
      const res = await reapPOST(
        authReq("/api/discovery/reap", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: json(value === undefined ? {} : { staleAfterMinutes: value }),
        }),
      );
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ code: "bad_stale_threshold" });
    }
  });
});

describe("R4: response shapes match the published contract", () => {
  it("GET /api/opportunities returns {total, limit, offset, items}", async () => {
    const res = await opportunitiesGET(authReq("/api/opportunities?pipeline=agency_partner&limit=5"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      limit: number;
      offset: number;
      items: { opportunity_key: string; pipeline: string }[];
    };
    expect(Object.keys(body).sort()).toEqual(["items", "limit", "offset", "total"]);
    expect(body.limit).toBe(5);
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("GET /api/opportunities/[key] returns record + evidence + eligibility + lifecycle", async () => {
    const r = await runRefresh(pool, createRegistry([new AgencyDirectoryFixture()]), {
      tasks: [{ adapterId: "agency-directory-fixture", queryText: "f14-shape", limit: 3, maxPages: 1 }],
      actor: ACTOR,
    });
    expect(r.status).toBe("ok");
    const listed = (await (
      await opportunitiesGET(authReq(`/api/opportunities?q=${encodeURIComponent("fixture-")}`))
    ).json()) as { items: { opportunity_key: string }[]; total: number };
    expect(listed.total).toBeGreaterThan(0);
    const key = listed.items[0].opportunity_key;

    const res = await opportunityGET(authReq(`/api/opportunities/${encodeURIComponent(key)}`), {
      params: Promise.resolve({ key }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "eligibility_history",
      "evidence",
      "lifecycle",
      "opportunity",
    ]);
    // The detail view of an un-evaluated opportunity is an empty history, not a
    // fabricated one.
    expect(body["eligibility_history"]).toEqual([]);
  });

  it("GET /api/discovery/refreshes/[id] returns the summary contract", async () => {
    const r = await runRefresh(pool, createRegistry([new AgencyDirectoryFixture()]), {
      tasks: [{ adapterId: "agency-directory-fixture", queryText: "f14-summary", limit: 3, maxPages: 1 }],
      actor: ACTOR,
    });
    const res = await refreshGET(authReq(`/api/discovery/refreshes/${r.runId}?target_agency=50`), {
      params: Promise.resolve({ id: r.runId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runId: string;
      runStatus: string;
      endState: string;
      coverage: { total: number; done: number };
      measures: Record<string, number | string>;
      shortfall: { pipeline: string; target: number; actual: number; shortfall: number }[];
    };
    expect(body.runId).toBe(r.runId);
    expect(body.coverage.total).toBe(1);
    expect(Object.keys(body.measures).sort()).toEqual([
      "duplicates",
      "excluded",
      "measures_basis",
      "new_eligible",
      "new_evidence",
      "promoted",
      "stale",
      "unresolved",
      "unresolved_opportunities",
      "unresolved_tasks",
    ]);
    // F7/F8: the summary states what these numbers ARE, so Phase 2 cannot
    // mistake a live projection for a frozen run result.
    expect(body.measures["measures_basis"]).toBe("live_projection");
    expect(body.measures["unresolved"]).toBe(
      (body.measures["unresolved_opportunities"] as number) +
        (body.measures["unresolved_tasks"] as number),
    );
    // A caller-stated target produces an honest shortfall row (never a
    // fabricated pass, never a transfer between pipelines).
    expect(body.shortfall).toHaveLength(1);
    expect(body.shortfall[0].pipeline).toBe("agency_partner");
    expect(body.shortfall[0].target).toBe(50);
    expect(body.shortfall[0].shortfall).toBe(Math.max(0, 50 - body.shortfall[0].actual));
    await cleanup();
  });
});

describe("R5: the collection has no total-opportunity cap", () => {
  it("60 accumulated opportunities are all stored and all retrievable", async () => {
    try {
      const stamp = Date.now();
      for (let i = 0; i < 60; i++) {
        await registerOpportunity(pool, {
          pipeline: "agency_partner",
          sourceKey: "agency-directory",
          sourceRecordId: `F14-CAP-${stamp}-${i}`,
          actor: ACTOR,
        });
      }
      const stored = await pool.query(
        "select count(*)::int as n from public.opportunity where opportunity_key like $1",
        [`opp:agency_partner:agency-directory:f14-cap-${stamp}-%`],
      );
      expect(stored.rows[0].n).toBe(60);

      // Paging returns every row: 3 pages of 25 cover all 60, nothing is lost
      // to a silent cap.
      const seen = new Set<string>();
      for (const offset of [0, 25, 50]) {
        const res = await opportunitiesGET(
          authReq(`/api/opportunities?q=F14-CAP-${stamp}&limit=25&offset=${offset}`),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { total: number; items: { opportunity_key: string }[] };
        expect(body.total).toBe(60);
        for (const it of body.items) seen.add(it.opportunity_key);
      }
      expect(seen.size).toBe(60);
    } finally {
      await cleanup();
    }
  });
});

describe("R6: attribution comes from the session, never the request body (F9)", () => {
  it("a body-supplied actor cannot overwrite the session identity in audit rows", async () => {
    try {
      const runId = await newStaleRun();
      const res = await reapPOST(
        authReq("/api/discovery/reap", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: json({ staleAfterMinutes: 60, actor: "attacker@example.com", dryRun: false }),
        }),
      );
      expect(res.status).toBe(200);
      const audit = await pool.query(
        `select actor from public.audit_log
         where entity_type = 'discovery_run' and entity_id = $1 and reason like 'reaped:%'`,
        [runId],
      );
      expect(audit.rows.length).toBe(1);
      // The session identity won; the body label was ignored.
      expect(audit.rows[0].actor).toBe(OPERATOR);
      expect(audit.rows[0].actor).not.toBe("attacker@example.com");
      // And the run row itself records the same identity.
      const run = await pool.query("select created_by from public.discovery_run where id = $1", [runId]);
      expect(run.rows[0].created_by).toBe(ACTOR); // the fixture author, not the reaper
      const failure = await pool.query(
        "select entity_id from public.failure_log where entity_type = 'discovery_run' and entity_id = $1",
        [runId],
      );
      expect(failure.rows.length).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("eligibility decisions written through the library carry the caller actor", async () => {
    // Documents where attribution DOES come from: direct library calls pass an
    // explicit actor (routes pass the session identity).
    try {
      const stamp = Date.now();
      const o = await registerOpportunity(pool, {
        pipeline: "agency_partner",
        sourceKey: "agency-directory",
        sourceRecordId: `F14-ATTR-${stamp}`,
        actor: ACTOR,
      });
      await evaluateEligibility(
        pool,
        o.id,
        { version: "f14-policy", gates: [{ id: "g", passed: true, reason: "f14" }] },
        { actor: ACTOR },
      );
      const audit = await pool.query(
        `select actor from public.audit_log
         where entity_type = 'opportunity' and entity_id = $1 and transition_to = 'observed'`,
        [o.id],
      );
      expect(audit.rows[0].actor).toBe(ACTOR);
      const history = await pool.query(
        "select count(*)::int as n from public.opportunity_eligibility where opportunity_id = $1",
        [o.id],
      );
      expect(history.rows[0].n).toBe(1);
    } finally {
      await cleanup();
    }
  });
});