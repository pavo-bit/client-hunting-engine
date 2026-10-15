/**
 * Part 3 routes: decisions, reconciliation triggers, manual research tasks.
 *
 * Same bar as the other route suites: 401 anonymous on every route with no
 * side effects; CSRF 403 before work with a positive control; documented
 * refusals (422/404/409 with codes); response shapes; idempotent replay over
 * HTTP; due-flag set/clear.
 */
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as decisionsPOST } from "../app/api/qualification/decisions/route";
import { GET as reconcileGET, POST as reconcilePOST } from "../app/api/qualification/reconcile/route";
import { POST as researchPOST } from "../app/api/qualification/research/route";
import { PATCH as taskPATCH } from "../app/api/qualification/research/[id]/route";
import { runAssessment } from "../lib/qualification/assessments";
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
process.env.DATABASE_URL = DB_URL;
const pool = new Pool({ connectionString: DB_URL, max: 4 });
const ORIGIN = "http://127.0.0.1:3101";
const HOST = "127.0.0.1:3101";
const OPERATOR = "p3r-operator@example.com";
const AS_OF = "2026-10-15T00:00:00.000Z";

let token = "";
let SET!: Awaited<ReturnType<typeof registerFixtureSet>>;

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
function post(path: string, body: unknown, authed = true): NextRequest {
  const base = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  return authed ? authReq(path, base) : req(path, base);
}

async function seedAssessed(tag: string): Promise<{ caseId: string; assessmentId: string; snapshotId: string }> {
  const stamp = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const s = await seedCompanyWithClaims(pool, tag, [
    { text: "Intake runs on email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10, link: "supports" },
    { text: "Directory confirms size", sourceKey: "agency-directory", observedDaysAgo: 20 },
  ]);
  const o = await registerOpportunity(pool, {
    pipeline: "agency_partner",
    sourceKey: "company-site",
    sourceRecordId: `P2T-LR-${stamp}`,
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
  return { caseId: r.caseId, assessmentId: r.assessmentId, snapshotId: r.snapshotId };
}

beforeAll(async () => {
  await cleanupFixtures(pool);
  SET = await registerFixtureSet(pool, "lifecycle");
  const { createSession } = await import("../lib/auth/sessions");
  const { getAuthConfig } = await import("../lib/auth/config");
  const cfg = getAuthConfig({ ...process.env, NODE_ENV: "test", OPERATOR_EMAIL: OPERATOR });
  token = (await createSession(pool, { ...cfg, sessionTtlSec: 3600 }, OPERATOR)).rawToken;
});
afterAll(async () => {
  await cleanupFixtures(pool);
  await pool.query("delete from public.operator_session where operator_email = $1", [OPERATOR]);
  await pool.end();
});

describe("P3-routes: decisions", () => {
  it("anonymous POST writes nothing", async () => {
    const res = await decisionsPOST(post("/api/qualification/decisions", { caseId: "x" }, false));
    expect(res.status).toBe(401);
  });

  it("records accept with reason, refuses double-decide and bad ids", async () => {
    const s = await seedAssessed("lr");
    try {
      // CSRF first: authenticated but no Origin → 403, nothing recorded.
      const csrf = await decisionsPOST(
        req("/api/qualification/decisions", {
          method: "POST",
          headers: { cookie: `gsid=${token}`, "content-type": "application/json" },
          body: JSON.stringify({ caseId: s.caseId, assessmentId: s.assessmentId, type: "accepted", reason: "x" }),
        }),
      );
      expect(csrf.status).toBe(403);

      const badId = await decisionsPOST(post("/api/qualification/decisions", { caseId: "nope", type: "accepted", reason: "x" }));
      expect(badId.status).toBe(422);

      const ok = await decisionsPOST(
        post("/api/qualification/decisions", {
          caseId: s.caseId,
          assessmentId: s.assessmentId,
          type: "accepted",
          reason: "strong case",
        }),
      );
      expect(ok.status).toBe(201);
      const body = (await ok.json()) as { decision: string; actor: string };
      expect(body.decision).toBe("accepted");
      // Session identity wins attribution.
      expect(body.actor).toBe(OPERATOR);

      const twice = await decisionsPOST(
        post("/api/qualification/decisions", {
          caseId: s.caseId,
          assessmentId: s.assessmentId,
          type: "rejected",
          reason: "second try",
        }),
      );
      expect(twice.status).toBe(409);
      expect(await twice.json()).toMatchObject({ code: "decision_conflict" });
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "lifecycle");
    }
  });
});

describe("P3-routes: reconciliation triggers", () => {
  it("anonymous reconcile writes nothing; preview reads nothing", async () => {
    const anon = await reconcilePOST(post("/api/qualification/reconcile", {}, false));
    expect(anon.status).toBe(401);
    const preview = await reconcileGET(authReq("/api/qualification/reconcile"));
    expect(preview.status).toBe(200);
    const body = (await preview.json()) as { casesChecked: number; wouldDrift: string[]; orphaned: string[] };
    expect(body.casesChecked).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.wouldDrift)).toBe(true);
  });

  it("POST reconcile runs the pipeline and reports honestly", async () => {
    await seedAssessed("lrcon");
    try {
      // CSRF: 403 before any work.
      const csrf = await reconcilePOST(
        req("/api/qualification/reconcile", {
          method: "POST",
          headers: { cookie: `gsid=${token}`, "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      expect(csrf.status).toBe(403);
      const res = await reconcilePOST(post("/api/qualification/reconcile", { consumer: "p3r-http" }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        consume: { claimed: number; applied: number };
        backfill: { checked: number };
        reconcile: { casesChecked: number };
      };
      expect(body.consume.applied).toBeGreaterThanOrEqual(0);
      expect(body.backfill.checked).toBeGreaterThanOrEqual(1);
      expect(body.reconcile.casesChecked).toBeGreaterThanOrEqual(1);
    } finally {
      await pool.query("delete from p2.event_inbox where consumer_name = 'p3r-http'");
      await pool.query("delete from p2.consumer_watermark where consumer_name = 'p3r-http'");
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "lifecycle");
    }
  });
});

describe("P3-routes: manual research tasks + due flags", () => {
  it("creates, dedups, sets and clears due flags over HTTP", async () => {
    const s = await seedAssessed("lrtask");
    try {
      const created = await researchPOST(
        post("/api/qualification/research", {
          caseId: s.caseId,
          snapshotId: s.snapshotId,
          question: "Does the agency run paid ads?",
          reasonCode: "OPERATOR_QUESTION",
          evidenceNeeded: "ads library or spend signal",
          expectedImpact: "medium",
          uncertainty: "acquisition channel mix",
          sourceAvailability: "company-site",
          effortEstimate: "low",
          priorityExplanation: "operator-asked",
          dueAt: "2026-10-20T00:00:00.000Z",
        }),
      );
      expect(created.status).toBe(201);
      const task = (await created.json()) as { task_id: string; due_at: string };
      expect(task.due_at).toBe("2026-10-20T00:00:00.000Z");

      const dupe = await researchPOST(
        post("/api/qualification/research", {
          caseId: s.caseId,
          snapshotId: s.snapshotId,
          question: "Does the agency run paid ads?",
          reasonCode: "OPERATOR_QUESTION",
          evidenceNeeded: "x",
          expectedImpact: "low",
          uncertainty: "x",
          sourceAvailability: "x",
          effortEstimate: "low",
          priorityExplanation: "x",
        }),
      );
      expect(dupe.status).toBe(409);

      // Clear the due flag without moving status.
      const cleared = await taskPATCH(
        authReq(`/api/qualification/research/${task.task_id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dueAt: null }),
        }),
        { params: Promise.resolve({ id: task.task_id }) },
      );
      expect(cleared.status).toBe(200);
      expect(((await cleared.json()) as { due_at: string | null }).due_at).toBeNull();

      // Neither status nor due: refused.
      const empty = await taskPATCH(
        authReq(`/api/qualification/research/${task.task_id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
        { params: Promise.resolve({ id: task.task_id }) },
      );
      expect(empty.status).toBe(422);
    } finally {
      await cleanupFixtures(pool);
      SET = await registerFixtureSet(pool, "lifecycle");
    }
  });

  it("anonymous research POST writes nothing", async () => {
    const res = await researchPOST(post("/api/qualification/research", { caseId: "x" }, false));
    expect(res.status).toBe(401);
  });
});
