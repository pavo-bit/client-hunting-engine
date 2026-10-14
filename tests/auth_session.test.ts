/**
 * AUTH-001 session + route integration tests.
 *
 * Exercises the REAL route handlers in-process (next/server loads under
 * vitest) against the LOCAL test database, with an isolated test credential.
 * Never touches the development database: DATABASE_URL is pointed at the test
 * DB before any handler runs, and every created row is removed afterwards.
 */
import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getAuthConfig } from "../lib/auth/config";
import { _resetRateLimit } from "../lib/auth/ratelimit";
import {
  countLiveSessions,
  revokeSession,
  SESSION_COOKIE,
  validateSession,
} from "../lib/auth/sessions";
import { hashPassword } from "../lib/auth/password";
import { POST as loginPOST } from "../app/api/auth/login/route";
import { POST as logoutPOST } from "../app/api/auth/logout/route";
import { GET as sessionGET } from "../app/api/auth/session/route";
import { GET as companiesGET, POST as companiesPOST } from "../app/api/companies/route";

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
// Route handlers resolve their pool from DATABASE_URL at call time.
process.env.DATABASE_URL = DB_URL;

const EMAIL = "auth001-test-operator@example.com";
const PASSWORD = "auth001-test-password-long-enough";
const WRONG = "auth001-wrong-password-long-enough";
const ORIGIN = "http://127.0.0.1:3101";
const OTHER_EMAILS = ["auth001-unknown@example.com", "auth001-locked@example.com"];

const pool = new Pool({ connectionString: DB_URL, max: 3 });

function jsonReq(path: string, body: unknown, extra: Record<string, string> = {}): NextRequest {
  // The Host header is set explicitly: the CSRF guard compares Origin/Referer
  // against it, and in-process constructed requests carry no Host otherwise.
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:3101", ...extra },
    body: JSON.stringify(body),
  });
}

function cookieOf(res: Response): string | null {
  const set = res.headers.get("set-cookie") ?? "";
  const m = set.match(/(?:^|,\s*)gsid=([^;]*)/);
  return m ? m[1] : null;
}

async function login(email = EMAIL, password = PASSWORD): Promise<{ res: Response; token: string | null }> {
  const res = await loginPOST(jsonReq("/api/auth/login", { email, password }));
  return { res, token: cookieOf(res) };
}

async function cleanup() {
  await pool.query("delete from public.operator_session where operator_email = $1", [EMAIL]);
  for (const e of OTHER_EMAILS) {
    await pool.query("delete from public.operator_session where operator_email = $1", [e]);
  }
  await pool.query("delete from public.company where domain_norm like 'auth001-%'");
  // NOTE: audit_log rows are append-only by trigger (not even the owner can
  // delete them) and are intentionally left as history. The audit test below
  // scopes to rows created after T0 so reruns stay deterministic.
}

let T0 = new Date(0);

beforeAll(async () => {
  process.env.OPERATOR_EMAIL = EMAIL;
  process.env.OPERATOR_PASSWORD_HASH = await hashPassword(PASSWORD);
  process.env.OPERATOR_API_TOKEN = "";
  delete process.env.AUTH_DEV_OPEN;
  process.env.AUTH_LOGIN_MAX_ATTEMPTS = "3";
  process.env.AUTH_LOGIN_WINDOW_SEC = "60";
  process.env.AUTH_LOGIN_LOCK_SEC = "60";
  _resetRateLimit();
  T0 = new Date();
  await cleanup();
}, 120000);

afterEach(async () => {
  _resetRateLimit();
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("login endpoint", () => {
  it("authenticates valid credentials and sets a hardened session cookie", async () => {
    const { res, token } = await login();
    expect(res.status).toBe(200);
    expect(token).toBeTruthy();
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toContain("HttpOnly");
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toContain("Path=/");
    expect(set).toMatch(/Max-Age=43200/i);
    expect(set).not.toMatch(/;\s*Domain=/i);
    // Not marked Secure in non-production test env (asserted flipped in config test).
    expect(set).not.toMatch(/;\s*Secure/i);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    // No secret material in the body.
    const text = JSON.stringify(body);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(process.env.OPERATOR_PASSWORD_HASH ?? "unset-hash");
    expect(text).not.toContain(token ?? "unset-token");
    // The session validates server-side.
    const session = await validateSession(pool, getAuthConfig(), token!);
    expect(session?.operatorEmail).toBe(EMAIL);
  });

  it("rejects wrong passwords and unknown emails with one generic message", async () => {
    const bad = await loginPOST(jsonReq("/api/auth/login", { email: EMAIL, password: WRONG }));
    expect(bad.status).toBe(401);
    const unknown = await loginPOST(
      jsonReq("/api/auth/login", { email: OTHER_EMAILS[0], password: WRONG }),
    );
    expect(unknown.status).toBe(401);
    // Indistinguishable responses: same code, same message, no hint.
    const badBody = (await bad.json()) as Record<string, unknown>;
    const unknownBody = (await unknown.json()) as Record<string, unknown>;
    expect(unknownBody).toEqual(badBody);
    expect(badBody).toEqual({
      code: "invalid_credentials",
      message: "Invalid email or password.",
    });
  });

  it("rejects malformed inputs without touching credentials", async () => {
    const before = await countLiveSessions(pool, EMAIL);
    for (const body of [{}, { email: "x" }, { email: "a@b.co" }, { email: EMAIL }, { email: EMAIL, password: "" }]) {
      const r = await loginPOST(jsonReq("/api/auth/login", body));
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(cookieOf(r)).toBeFalsy();
    }
    // Malformed input never mints a session.
    expect(await countLiveSessions(pool, EMAIL)).toBe(before);
  });

  it("throttles repeated failures and recovers after reset", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await loginPOST(jsonReq("/api/auth/login", { email: EMAIL, password: WRONG }));
      expect(r.status).toBe(401);
    }
    const locked = await loginPOST(jsonReq("/api/auth/login", { email: EMAIL, password: WRONG }));
    expect(locked.status).toBe(429);
    expect(await locked.json()).toEqual({
      code: "rate_limited",
      message: "Too many attempts. Try again later.",
    });
    // Even the right password is refused while locked (no oracle).
    const alsoLocked = await loginPOST(jsonReq("/api/auth/login", { email: EMAIL, password: PASSWORD }));
    expect(alsoLocked.status).toBe(429);
  });

  it("fails closed with 503 when no credential is provisioned", async () => {
    const savedEmail = process.env.OPERATOR_EMAIL;
    const savedHash = process.env.OPERATOR_PASSWORD_HASH;
    delete process.env.OPERATOR_EMAIL;
    delete process.env.OPERATOR_PASSWORD_HASH;
    try {
      const r = await loginPOST(jsonReq("/api/auth/login", { email: EMAIL, password: PASSWORD }));
      expect(r.status).toBe(503);
      expect(cookieOf(r)).toBeFalsy();
      const body = (await r.json()) as Record<string, unknown>;
      expect(body.code).toBe("auth_unavailable");
      expect(JSON.stringify(body)).not.toContain(PASSWORD);
    } finally {
      process.env.OPERATOR_EMAIL = savedEmail;
      process.env.OPERATOR_PASSWORD_HASH = savedHash;
    }
  });
});

describe("session lifecycle", () => {
  it("rotates the identifier on every login (old sessions die)", async () => {
    const a = await login();
    expect(a.res.status).toBe(200);
    const b = await login();
    expect(b.res.status).toBe(200);
    expect(b.token).toBeTruthy();
    expect(b.token).not.toBe(a.token);
    expect(await countLiveSessions(pool, EMAIL)).toBe(1);
    // Old token authorizes nothing.
    const stale = await companiesGET(
      new NextRequest(`${ORIGIN}/api/companies`, { headers: { cookie: `${SESSION_COOKIE}=${a.token}` } }),
    );
    expect(stale.status).toBe(401);
    const fresh = await companiesGET(
      new NextRequest(`${ORIGIN}/api/companies`, { headers: { cookie: `${SESSION_COOKIE}=${b.token}` } }),
    );
    expect(fresh.status).toBe(200);
  });

  it("rejects expired sessions and marks them revoked", async () => {
    const { token } = await login();
    const digest = createHash("sha256").update(token!, "utf8").digest("hex");
    await pool.query("update public.operator_session set expires_at = now() - interval '1 minute' where token_hash = $1", [
      digest,
    ]);
    const r = await companiesGET(
      new NextRequest(`${ORIGIN}/api/companies`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
    );
    expect(r.status).toBe(401);
    const row = await pool.query("select revoked_at from public.operator_session where token_hash = $1", [digest]);
    expect(row.rows[0].revoked_at).not.toBeNull();
  });

  it("rejects revoked sessions", async () => {
    const { token } = await login();
    expect(await revokeSession(pool, token!)).toBe(true);
    const r = await companiesGET(
      new NextRequest(`${ORIGIN}/api/companies`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
    );
    expect(r.status).toBe(401);
    // Unknown tokens are simply invalid (no oracle, no error).
    const unknown = await companiesGET(
      new NextRequest(`${ORIGIN}/api/companies`, { headers: { cookie: `${SESSION_COOKIE}=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` } }),
    );
    expect(unknown.status).toBe(401);
  });

  it("stores digests, never raw tokens", async () => {
    const { token } = await login();
    const rows = await pool.query("select token_hash from public.operator_session where revoked_at is null");
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.token_hash).not.toContain(token!);
    }
  });

  it("logs out by revoking server-side and clearing the cookie", async () => {
    const { token } = await login();
    const out = await logoutPOST(
      new NextRequest(`${ORIGIN}/api/auth/logout`, {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
    );
    expect(out.status).toBe(200);
    const cleared = out.headers.get("set-cookie") ?? "";
    expect(cleared).toMatch(/Max-Age=0/i);
    const after = await companiesGET(
      new NextRequest(`${ORIGIN}/api/companies`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
    );
    expect(after.status).toBe(401);
    // Logout without a session still succeeds without leaking anything.
    const bare = await logoutPOST(new NextRequest(`${ORIGIN}/api/auth/logout`, { method: "POST" }));
    expect(bare.status).toBe(200);
  });
});

describe("authorization of protected routes", () => {
  it("denies anonymous reads and mutations with 401 and no private data", async () => {
    const get = await companiesGET(new NextRequest(`${ORIGIN}/api/companies`));
    expect(get.status).toBe(401);
    const getBody = (await get.json()) as Record<string, unknown>;
    expect(getBody.code).toBe("unauthorized");
    expect(getBody).not.toHaveProperty("companies");

    const post = await companiesPOST(
      jsonReq("/api/companies", { name: "Anonymous Co", domain: "auth001-anon.example" }),
    );
    expect(post.status).toBe(401);
  });

  it("denies empty or wrong legacy bearer tokens (no open mode)", async () => {
    const none = await companiesGET(new NextRequest(`${ORIGIN}/api/companies`));
    expect(none.status).toBe(401);
    const wrong = await companiesGET(
      new NextRequest(`${ORIGIN}/api/companies`, { headers: { authorization: "Bearer wrong" } }),
    );
    expect(wrong.status).toBe(401);
    // Empty configured token + presented empty bearer still fails.
    const empty = await companiesGET(
      new NextRequest(`${ORIGIN}/api/companies`, { headers: { authorization: "Bearer " } }),
    );
    expect(empty.status).toBe(401);
  });

  it("honors an explicitly configured bearer service credential", async () => {
    process.env.OPERATOR_API_TOKEN = "auth001-service-token";
    try {
      const r = await companiesGET(
        new NextRequest(`${ORIGIN}/api/companies`, { headers: { authorization: "Bearer auth001-service-token" } }),
      );
      expect(r.status).toBe(200);
      const bad = await companiesGET(
        new NextRequest(`${ORIGIN}/api/companies`, { headers: { authorization: "Bearer other" } }),
      );
      expect(bad.status).toBe(401);
    } finally {
      process.env.OPERATOR_API_TOKEN = "";
    }
  });

  it("enforces CSRF on cookie-authenticated mutations, skips it for bearer callers", async () => {
    const { token } = await login();
    const payload = {
      name: "Auth001 CSRF Co",
      domain: "auth001-csrf.example",
      agencyType: "web_development",
      country: "United States",
    };
    // Cookie session without Origin/Referer: rejected before any domain work.
    const noOrigin = await companiesPOST(
      jsonReq("/api/companies", payload, { cookie: `${SESSION_COOKIE}=${token}` }),
    );
    expect(noOrigin.status).toBe(403);
    expect(await noOrigin.json()).toEqual({ code: "forbidden", message: "origin check failed" });
    // Cross-origin: rejected.
    const evil = await companiesPOST(
      jsonReq("/api/companies", payload, {
        cookie: `${SESSION_COOKIE}=${token}`,
        origin: "https://evil.example",
      }),
    );
    expect(evil.status).toBe(403);
    // Same-origin: proceeds to domain logic (201) and attributes the operator.
    const ok = await companiesPOST(
      jsonReq("/api/companies", payload, {
        cookie: `${SESSION_COOKIE}=${token}`,
        origin: ORIGIN,
      }),
    );
    expect(ok.status).toBe(201);
    const created = (await ok.json()) as { companyId: string };
    const row = await pool.query("select created_at from public.company where id = $1", [created.companyId]);
    expect(row.rows).toHaveLength(1);
    await pool.query("delete from public.company where id = $1", [created.companyId]);
  });

  // NOTE: the page-level redirect (unauthenticated page -> /login) cannot run
  // in-process: requireOperatorPage() reads next/headers cookies(), which only
  // exists inside a real request scope. It is verified by the production-build
  // HTTP smoke instead (see the AUTH-001 report): anonymous GET /review lands
  // on /login?next=%2Freview with a 307. safeNextPath() is unit-tested in
  // tests/auth.test.ts.

  it("exposes only auth state on the public session endpoint", async () => {
    const anon = await sessionGET(new NextRequest(`${ORIGIN}/api/auth/session`));
    expect(anon.status).toBe(200);
    expect(await anon.json()).toEqual({ authenticated: false });
    const { token } = await login();
    const authed = await sessionGET(
      new NextRequest(`${ORIGIN}/api/auth/session`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
    );
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual({ authenticated: true, email: EMAIL, viaServiceToken: false });
  });
});

describe("auth audit trail", () => {
  it("records success, failure, and logout without any secret", async () => {
    await loginPOST(jsonReq("/api/auth/login", { email: EMAIL, password: WRONG }));
    const { token } = await login();
    await logoutPOST(
      new NextRequest(`${ORIGIN}/api/auth/logout`, {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
    );
    const rows = await pool.query<{ transition_to: string; entity_id: string; reason: string; actor: string }>(
      `select transition_to, entity_id, reason, actor from public.audit_log
       where entity_type = 'auth' and entity_id = $1 and created_at >= $2 order by created_at`,
      [EMAIL, T0.toISOString()],
    );
    const transitions = rows.rows.map((r) => r.transition_to);
    expect(transitions).toContain("login");
    expect(transitions).toContain("login_failed");
    expect(transitions).toContain("logout");
    const text = JSON.stringify(rows.rows);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(WRONG);
    expect(text).not.toContain(process.env.OPERATOR_PASSWORD_HASH ?? "unset-hash");
    expect(text).not.toContain(token ?? "unset-token");
  });
});
