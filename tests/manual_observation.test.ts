/**
 * Phase 1 signal foundation: controlled manual-observation workflow.
 *
 * Proves end to end (isolated test DB): an authenticated operator records an
 * observation about a resolved company; the source permission gate blocks
 * disabled sources before ANY write; unknown companies/sources are refused;
 * identical resubmissions collapse onto the existing snapshot without
 * duplicating claims or audit rows; new signal predicates validate;
 * personal contact data is refused by validation; publication dates store
 * separately from observation dates (or stay null, never defaulted).
 * Qualification governance is untouched: no policy published, direct-client
 * rows never created.
 */
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { ingestObservation } from "../lib/evidence/ingest";
import { POST as ingestPOST } from "../app/api/evidence/ingest/route";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
process.env.DATABASE_URL = DB_URL;
const pool = new Pool({ connectionString: DB_URL, max: 4 });
const ACTOR = "p1sig";
const ORIGIN = "http://127.0.0.1:3101";
const OPERATOR = "p1sig-operator@example.com";
const DISABLED_SOURCE = "p1sig-disabled-src";

let token = "";

async function cleanup(): Promise<void> {
  // NOTE: neither the disabled source row nor the operator session is
  // removed here — per-test cleanup must not revoke the suite's own
  // credentials or permission fixtures (both are torn down in afterAll).
  const c = await pool.connect();
  try {
    await c.query("delete from public.claim where claim_text like 'P1SIG%'");
    await c.query("delete from public.snapshot where content_excerpt like 'P1SIG%'");
    await c.query("delete from public.company where domain_norm like 'p1sig-%'");
  } finally {
    c.release();
  }
}

async function seedCompany(tag: string): Promise<string> {
  const co = await createCompany(
    pool,
    {
      name: `P1sig ${tag} Co`,
      domain: `p1sig-${tag}-${Date.now()}.example`,
      agencyType: "web_development",
      country: "United States",
    },
    ACTOR,
  );
  return co.companyId;
}

async function counts(companyId: string): Promise<{ snapshots: number; claims: number; audits: number }> {
  const c = await pool.connect();
  try {
    const s = await c.query("select count(*)::int as n from public.snapshot where company_id = $1", [companyId]);
    const cl = await c.query("select count(*)::int as n from public.claim where company_id = $1", [companyId]);
    // Audit rows scoped to THIS company's records (actor-global counts leak
    // across tests sharing one actor).
    const a = await c.query(
      `select count(*)::int as n from public.audit_log
       where entity_id in (select id::text from public.snapshot where company_id = $1)
          or entity_id in (select id::text from public.claim where company_id = $1)`,
      [companyId],
    );
    return { snapshots: s.rows[0].n as number, claims: cl.rows[0].n as number, audits: a.rows[0].n as number };
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await cleanup();
  const { createSession } = await import("../lib/auth/sessions");
  const { getAuthConfig } = await import("../lib/auth/config");
  const cfg = getAuthConfig({ ...process.env, NODE_ENV: "test", OPERATOR_EMAIL: OPERATOR });
  token = (await createSession(pool, { ...cfg, sessionTtlSec: 3600 }, OPERATOR)).rawToken;
  await pool.query(
    `insert into public.source (key, category, platform, reliability_prior, enabled, kind)
     values ($1, 'S-05', 'P1SIG disabled probe', 'C', false, 'connector')`,
    [DISABLED_SOURCE],
  );
});

afterAll(async () => {
  await pool.query("delete from public.source where key = $1", [DISABLED_SOURCE]);
  await pool.query("delete from public.operator_session where operator_email = $1", [OPERATOR]);
  await cleanup();
  await pool.end();
});

describe("P1-signal: happy path persists a traceable signal", () => {
  it("records snapshot + claim + audit with publication date separated", async () => {
    const companyId = await seedCompany("happy");
    try {
      const r = await ingestObservation(
        pool,
        {
          companyId,
          sourceKey: "company-site",
          url: "https://example.com/p1sig/portal-need",
          excerpt: "P1SIG excerpt: intake runs on email",
          observedAt: "2026-10-10T00:00:00.000Z",
          actor: ACTOR,
        },
        {
          predicate: "service_request",
          text: "P1SIG claim: agency requests external portal build help",
          reliability: "B",
          credibility: 2,
          publishedAt: "2026-10-09T00:00:00.000Z",
        },
      );
      expect(r.existed).toBe(false);
      expect(r.claimId).not.toBeNull();
      const row = await pool.query(
        `select cl.claim_text, cl.predicate, cl.published_at, cl.observed_at,
                s.url, s.source_key, s.sha256
         from public.claim cl join public.snapshot s on s.id = cl.snapshot_id
         where cl.id = $1`,
        [r.claimId],
      );
      expect(row.rows[0].predicate).toBe("service_request");
      expect(new Date(row.rows[0].published_at).toISOString()).toBe("2026-10-09T00:00:00.000Z");
      // Observation date is recorded as passed (distinct from publication date).
      expect(new Date(row.rows[0].observed_at).toISOString()).toBe("2026-10-10T00:00:00.000Z");
      expect(row.rows[0].source_key).toBe("company-site");
      expect(row.rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
      // Audit trail for both rows.
      const audits = await pool.query(
        "select entity_type, transition_to from public.audit_log where actor = $1 and entity_id in ($2, $3)",
        [ACTOR, r.snapshotId, r.claimId as string],
      );
      expect(audits.rows.map((x: { entity_type: string }) => x.entity_type).sort()).toEqual(["claim", "snapshot"]);
    } finally {
      await cleanup();
    }
  });

  it("publishedAt stays null when the source states no date (never defaulted)", async () => {
    const companyId = await seedCompany("nodate");
    try {
      const r = await ingestObservation(
        pool,
        { companyId, sourceKey: "company-site", url: "https://example.com/p1sig/nodate", actor: ACTOR },
        { text: "P1SIG claim without publication date", reliability: "C", credibility: 3 },
      );
      const row = await pool.query("select published_at from public.claim where id = $1", [r.claimId]);
      expect(row.rows[0].published_at).toBeNull();
      await expect(
        ingestObservation(
          pool,
          { companyId, sourceKey: "company-site", url: "https://example.com/p1sig/baddate", actor: ACTOR },
          { text: "P1SIG bad date", reliability: "B", credibility: 2, publishedAt: "not-a-date" },
        ),
      ).rejects.toMatchObject({ status: 422, code: "bad_published_at" });
    } finally {
      await cleanup();
    }
  });
});

describe("P1-signal: permission gate blocks before any write", () => {
  it("a disabled source is refused with 409 and writes nothing", async () => {
    const companyId = await seedCompany("disabled");
    try {
      const before = await counts(companyId);
      await expect(
        ingestObservation(
          pool,
          { companyId, sourceKey: DISABLED_SOURCE, url: "https://example.com/p1sig/blocked", actor: ACTOR },
          { text: "P1SIG must never persist", reliability: "B", credibility: 2 },
        ),
      ).rejects.toMatchObject({ status: 409, code: "source_disabled" });
      expect(await counts(companyId)).toEqual(before);
    } finally {
      await cleanup();
    }
  });

  it("unknown source and unknown company are refused with nothing written", async () => {
    const companyId = await seedCompany("unknown");
    try {
      const before = await counts(companyId);
      await expect(
        ingestObservation(
          pool,
          { companyId, sourceKey: "p1sig-nope", url: "https://example.com/p1sig/x", actor: ACTOR },
          { text: "P1SIG unknown source", reliability: "B", credibility: 2 },
        ),
      ).rejects.toMatchObject({ status: 422, code: "unknown_source" });
      await expect(
        ingestObservation(
          pool,
          {
            companyId: "11111111-2222-4333-8444-555555555555",
            sourceKey: "company-site",
            url: "https://example.com/p1sig/y",
            actor: ACTOR,
          },
          { text: "P1SIG unknown company", reliability: "B", credibility: 2 },
        ),
      ).rejects.toMatchObject({ status: 404, code: "company_not_found" });
      expect(await counts(companyId)).toEqual(before);
    } finally {
      await cleanup();
    }
  });
});

describe("P1-signal: duplicates collapse, never duplicate", () => {
  it("identical resubmission returns the existing snapshot with no new rows", async () => {
    const companyId = await seedCompany("dupe");
    try {
      const input = {
        companyId,
        sourceKey: "company-site",
        url: "https://example.com/p1sig/same",
        excerpt: "P1SIG same excerpt",
        actor: ACTOR,
      } as const;
      const first = await ingestObservation(pool, { ...input }, { text: "P1SIG same claim", reliability: "B", credibility: 2 });
      expect(first.existed).toBe(false);
      const mid = await counts(companyId);
      const second = await ingestObservation(pool, { ...input }, { text: "P1SIG same claim", reliability: "B", credibility: 2 });
      expect(second.existed).toBe(true);
      expect(second.snapshotId).toBe(first.snapshotId);
      expect(second.claimId).toBeNull();
      // No new claim, no new audit rows: the resubmission is a no-op read.
      expect(await counts(companyId)).toEqual(mid);
    } finally {
      await cleanup();
    }
  });
});

describe("P1-signal: predicates and privacy validation", () => {
  it("new signal predicates validate; unknown ones still refuse", async () => {
    const companyId = await seedCompany("pred");
    try {
      for (const p of ["partnership", "growth", "service_request", "hiring"]) {
        const r = await ingestObservation(
          pool,
          { companyId, sourceKey: "company-site", url: `https://example.com/p1sig/${p}`, actor: ACTOR },
          { predicate: p, text: `P1SIG ${p} claim`, reliability: "B", credibility: 2 },
        );
        expect(r.claimId).not.toBeNull();
      }
      await expect(
        ingestObservation(
          pool,
          { companyId, sourceKey: "company-site", url: "https://example.com/p1sig/badpred", actor: ACTOR },
          { predicate: "vibes", text: "P1SIG bad predicate", reliability: "B", credibility: 2 },
        ),
      ).rejects.toMatchObject({ status: 422, code: "bad_predicate" });
    } finally {
      await cleanup();
    }
  });

  it("personal contact data is refused without echoing it", async () => {
    const companyId = await seedCompany("pii");
    try {
      const before = await counts(companyId);
      const cases: [string, string][] = [
        ["claim text", "P1SIG contact Jane Smith at jane.smith@example.com for details"],
        ["excerpt", "P1SIG excerpt"],
      ];
      // claim-text case carries the address inside the claim itself.
      await expect(
        ingestObservation(
          pool,
          { companyId, sourceKey: "company-site", url: "https://example.com/p1sig/pii1", actor: ACTOR },
          { text: "P1SIG reach jane.smith@example.com anytime", reliability: "B", credibility: 2 },
        ),
      ).rejects.toMatchObject({ status: 422, code: "personal_contact" });
      // excerpt case.
      await expect(
        ingestObservation(
          pool,
          {
            companyId,
            sourceKey: "company-site",
            url: "https://example.com/p1sig/pii2",
            excerpt: "P1SIG call bob.jones@example.com today",
            actor: ACTOR,
          },
          { text: "P1SIG clean claim", reliability: "B", credibility: 2 },
        ),
      ).rejects.toMatchObject({ status: 422, code: "personal_contact" });
      // URL case: personal profile paths refuse.
      await expect(
        ingestObservation(
          pool,
          { companyId, sourceKey: "company-site", url: "https://linkedin.com/in/janesmith", actor: ACTOR },
          { text: "P1SIG profile claim", reliability: "B", credibility: 2 },
        ),
      ).rejects.toMatchObject({ status: 422, code: "personal_profile" });
      void cases;
      // The rejection must not echo the address anywhere in the error.
      try {
        await ingestObservation(
          pool,
          { companyId, sourceKey: "company-site", url: "https://example.com/p1sig/pii3", actor: ACTOR },
          { text: "P1SIG mail alice.wonder@example.com now", reliability: "B", credibility: 2 },
        );
        expect.unreachable();
      } catch (e: unknown) {
        expect(JSON.stringify(e)).not.toContain("alice.wonder@example.com");
      }
      // Role-based business channels pass; single handles pass (undeterminable).
      for (const ok of ["info@example.com", "contact@example.com", "support@example.com", "john@example.com"]) {
        const r = await ingestObservation(
          pool,
          { companyId, sourceKey: "company-site", url: `https://example.com/p1sig/ok-${ok.split("@")[0]}`, actor: ACTOR },
          { text: `P1SIG write to ${ok} for sales`, reliability: "B", credibility: 2 },
        );
        expect(r.claimId).not.toBeNull();
      }
      // Company profile pages (not personal) pass.
      const corp = await ingestObservation(
        pool,
        { companyId, sourceKey: "company-site", url: "https://linkedin.com/company/acme", actor: ACTOR },
        { text: "P1SIG company page", reliability: "B", credibility: 2 },
      );
      expect(corp.claimId).not.toBeNull();
      // Nothing refused persisted.
      const after = await counts(companyId);
      expect(after.snapshots).toBe(5);
      expect(after.claims).toBe(5);
      expect(before).toEqual({ snapshots: 0, claims: 0, audits: 0 });
    } finally {
      await cleanup();
    }
  });
});

describe("P1-signal: HTTP contract (auth, CSRF, errors)", () => {
  function post(body: unknown, headers: Record<string, string> = {}): NextRequest {
    return new NextRequest(`${ORIGIN}/api/evidence/ingest`, {
      method: "POST",
      headers: { host: "127.0.0.1:3101", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("anonymous requests are 401 with no writes", async () => {
    const companyId = await seedCompany("anon");
    try {
      const before = await counts(companyId);
      const res = await ingestPOST(post({ companyId, sourceKey: "company-site", url: "https://example.com/p1sig/anon" }));
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: "unauthorized" });
      expect(await counts(companyId)).toEqual(before);
    } finally {
      await cleanup();
    }
  });

  it("authenticated POST without Origin is 403 before any work (positive control proceeds)", async () => {
    const companyId = await seedCompany("csrf");
    try {
      const denied = await ingestPOST(
        post(
          { companyId, sourceKey: "company-site", url: "https://example.com/p1sig/csrf" },
          { cookie: `gsid=${token}` },
        ),
      );
      expect(denied.status).toBe(403);
      const tagged = await pool.query("select count(*)::int as n from public.snapshot where company_id = $1", [companyId]);
      expect(tagged.rows[0].n).toBe(0);

      const ok = await ingestPOST(
        post(
          {
            companyId,
            sourceKey: "company-site",
            url: "https://example.com/p1sig/csrf-ok",
            excerpt: "P1SIG csrf ok",
            claim: { predicate: "partnership", text: "P1SIG csrf claim", reliability: "B", credibility: 2 },
          },
          { cookie: `gsid=${token}`, origin: ORIGIN },
        ),
      );
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { snapshotId: string; existed: boolean; claimId: string | null };
      expect(body.existed).toBe(false);
      expect(body.claimId).not.toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("validation errors are useful and secret-free", async () => {
    const companyId = await seedCompany("errs");
    try {
      const badUrl = await ingestPOST(
        post(
          { companyId, sourceKey: "company-site", url: "ftp://example.com/x" },
          { cookie: `gsid=${token}`, origin: ORIGIN },
        ),
      );
      expect(badUrl.status).toBe(422);
      const b = (await badUrl.json()) as { code: string; message: string };
      expect(b.code).toBe("bad_url");
      expect(JSON.stringify(b)).not.toMatch(/postgres|5434|TOKEN|HASH/i);
      const disabled = await ingestPOST(
        post(
          { companyId, sourceKey: DISABLED_SOURCE, url: "https://example.com/p1sig/r" },
          { cookie: `gsid=${token}`, origin: ORIGIN },
        ),
      );
      expect(disabled.status).toBe(409);
      expect(await disabled.json()).toMatchObject({ code: "source_disabled" });
    } finally {
      await cleanup();
    }
  });
});

describe("P1-signal: qualification governance untouched", () => {
  it("no policy published and no direct-client rows result from this workflow", async () => {
    const active = await pool.query(
      "select count(*)::int as n from p2.reference_version where status = 'active'",
    );
    expect(active.rows[0].n).toBe(0);
    const dc = await pool.query("select count(*)::int as n from public.opportunity where pipeline = 'direct_client'");
    expect(dc.rows[0].n).toBe(0);
  });
});
