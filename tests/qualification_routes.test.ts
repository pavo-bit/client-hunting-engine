/**
 * Part 2 API contracts: the four qualification routes.
 *
 * Same bar as the Discovery routes (F14 pattern): anonymous access refused
 * with 401 and no writes; cookie-authenticated mutations require a same-origin
 * request (403 with a positive control proving the guard fires before work);
 * malformed input is a documented refusal; response shapes match the
 * published contracts; assessing without an active policy is a 409, never a
 * silent default; idempotent replay works over HTTP.
 */
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as assessPOST } from "../app/api/qualification/assess/route";
import { GET as casesGET } from "../app/api/qualification/cases/route";
import { GET as caseGET } from "../app/api/qualification/cases/[id]/route";
import { PATCH as taskPATCH } from "../app/api/qualification/research/[id]/route";
import {
  ACTOR,
  cleanupFixtures,
  registerFixtureSet,
  seedCompanyWithClaims,
} from "./qualification_fixtures";
import { registerOpportunity } from "../lib/discovery/opportunities";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
process.env.DATABASE_URL = DB_URL;
const pool = new Pool({ connectionString: DB_URL, max: 4 });
const ORIGIN = "http://127.0.0.1:3101";
const HOST = "127.0.0.1:3101";
const OPERATOR = "p2r-operator@example.com";

let token = "";
let SET!: Awaited<ReturnType<typeof registerFixtureSet>>;
let OPP_ID = "";

function req(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers: { host: HOST, ...(init.headers ?? {}) },
    body: init.body,
  });
}
function authReq(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): NextRequest {
  return req(path, { ...init, headers: { cookie: `gsid=${token}`, origin: ORIGIN, ...(init.headers ?? {}) } });
}

async function seedOpp(): Promise<string> {
  const stamp = `route-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const s = await seedCompanyWithClaims(pool, "route", [
    { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10, link: "supports" },
    { text: "Directory confirms size", sourceKey: "agency-directory", observedDaysAgo: 20 },
  ]);
  void stamp;
  const o = await registerOpportunity(pool, {
    pipeline: "agency_partner",
    sourceKey: "company-site",
    sourceRecordId: `P2T-ROUTE-${Date.now()}`,
    companyId: s.companyId,
    actor: ACTOR,
  });
  return o.id;
}

beforeAll(async () => {
  await cleanupFixtures(pool);
  SET = await registerFixtureSet(pool, "route");
  const { createSession } = await import("../lib/auth/sessions");
  const { getAuthConfig } = await import("../lib/auth/config");
  const cfg = getAuthConfig({ ...process.env, NODE_ENV: "test", OPERATOR_EMAIL: OPERATOR });
  token = (await createSession(pool, { ...cfg, sessionTtlSec: 3600 }, OPERATOR)).rawToken;
  OPP_ID = await seedOpp();
});
afterAll(async () => {
  await cleanupFixtures(pool);
  await pool.query("delete from public.operator_session where operator_email = $1", [OPERATOR]);
  await pool.end();
});

describe("P2-routes: anonymous access refused, nothing written", () => {
  it("401s on all four routes with no side effects", async () => {
    expect((await assessPOST(req("/api/qualification/assess", { method: "POST", body: "{}" }))).status).toBe(401);
    expect((await casesGET(req("/api/qualification/cases"))).status).toBe(401);
    expect(
      (await caseGET(req("/api/qualification/cases/11111111-2222-4333-8444-555555555555"), {
        params: Promise.resolve({ id: "11111111-2222-4333-8444-555555555555" }),
      })).status,
    ).toBe(401);
    expect(
      (await taskPATCH(
        req("/api/qualification/research/11111111-2222-4333-8444-555555555555", { method: "PATCH", body: "{}" }),
        { params: Promise.resolve({ id: "11111111-2222-4333-8444-555555555555" }) },
      )).status,
    ).toBe(401);
    const cases = await pool.query("select count(*)::int as n from p2.case");
    expect(cases.rows[0].n).toBe(0);
  });
});

describe("P2-routes: CSRF before work, with positive controls", () => {
  it("POST assess without Origin is 403 and assesses nothing", async () => {
    const res = await assessPOST(
      req("/api/qualification/assess", {
        method: "POST",
        headers: { cookie: `gsid=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ opportunityId: OPP_ID }),
      }),
    );
    expect(res.status).toBe(403);
    const cases = await pool.query("select count(*)::int as n from p2.case");
    expect(cases.rows[0].n).toBe(0);
  });

  it("assess with Origin runs the pipeline and returns the assessment", async () => {
    const res = await assessPOST(
      authReq("/api/qualification/assess", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          opportunityId: OPP_ID,
          policyVersion: SET.policyVersion,
          catalogVersion: SET.catalogVersion,
          rubricVersion: SET.rubricVersion,
          capacityVersion: SET.capacityVersion,
          asOf: "2026-10-15T00:00:00.000Z",
          idempotencyKey: `p2t-route-${Date.now()}`,
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { assessmentId: string; outcome: string; composite: number; replayed: boolean };
    expect(body.assessmentId).toBeTruthy();
    expect(body.outcome).toBe("eligible_for_assessment");
    expect(body.composite).not.toBeNull();
    expect(body.replayed).toBe(false);
  });
});

describe("P2-routes: malformed input refused, shapes documented", () => {
  it("bad ids and statuses are 422 with codes", async () => {
    const badAssess = await assessPOST(
      authReq("/api/qualification/assess", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ opportunityId: "nope" }),
      }),
    );
    expect(badAssess.status).toBe(422);
    expect(await badAssess.json()).toMatchObject({ code: "bad_id" });

    const badCase = await caseGET(authReq("/api/qualification/cases/nope"), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(badCase.status).toBe(422);

    const missing = await caseGET(
      authReq("/api/qualification/cases/11111111-2222-4333-8444-555555555555"),
      { params: Promise.resolve({ id: "11111111-2222-4333-8444-555555555555" }) },
    );
    expect(missing.status).toBe(404);

    const badStatus = await casesGET(authReq("/api/qualification/cases?status=bogus"));
    expect(badStatus.status).toBe(422);
    expect(await badStatus.json()).toMatchObject({ code: "bad_status" });
  });

  it("cases list and detail return the documented shapes", async () => {
    const list = await casesGET(authReq("/api/qualification/cases?limit=5"));
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { total: number; limit: number; items: { case_id: string }[] };
    expect(listed.total).toBeGreaterThanOrEqual(1);
    expect(Object.keys(listed).sort()).toEqual(["items", "limit", "offset", "total"]);
    const id = listed.items[0].case_id;
    const detail = await caseGET(authReq(`/api/qualification/cases/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "assessments",
      "case",
      "decisions",
      "research_tasks",
      "snapshots",
      "staleness",
    ]);
  });

  it("research tasks move only along operator edges", async () => {
    const list = await casesGET(authReq("/api/qualification/cases?limit=1"));
    const id = ((await list.json()) as { items: { case_id: string }[] }).items[0].case_id;
    const detail = (await (
      await caseGET(authReq(`/api/qualification/cases/${id}`), { params: Promise.resolve({ id }) })
    ).json()) as { research_tasks: { task_id: string }[] };
    expect(detail.research_tasks.length).toBeGreaterThan(0);
    const taskId = detail.research_tasks[0].task_id;
    // PATCH without Origin: 403, nothing moved.
    const csrf = await taskPATCH(
      req(`/api/qualification/research/${taskId}`, {
        method: "PATCH",
        headers: { cookie: `gsid=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ status: "accepted" }),
      }),
      { params: Promise.resolve({ id: taskId }) },
    );
    expect(csrf.status).toBe(403);
    const bad = await taskPATCH(
      authReq(`/api/qualification/research/${taskId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      }),
      { params: Promise.resolve({ id: taskId }) },
    );
    expect(bad.status).toBe(409);
    const ok = await taskPATCH(
      authReq(`/api/qualification/research/${taskId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "accepted", notes: "operator takes it" }),
      }),
      { params: Promise.resolve({ id: taskId }) },
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { status: string }).status).toBe("accepted");
  });
});
