/**
 * AUTH-001 unit tests: closed bearer semantics + pure auth helpers + password
 * hashing + config + rate limiting. No database, no network. DB-backed
 * session and route tests live in tests/auth_session.test.ts.
 */
import { describe, expect, it } from "vitest";
import { checkOperatorToken } from "../lib/intake/http";
import {
  checkSameOrigin,
  checkServiceToken,
  clientIp,
  safeNextPath,
} from "../lib/auth/http";
import { assertAuthAvailable, getAuthConfig } from "../lib/auth/config";
import {
  getDummyHash,
  hashPassword,
  isPlausibleEmail,
  normalizeEmail,
  verifyPassword,
} from "../lib/auth/password";
import {
  _resetRateLimit,
  checkRateLimit,
  rateLimitKey,
  recordFailure,
  recordSuccess,
} from "../lib/auth/ratelimit";

const header = (value: string | null) => (name: string) =>
  name === "authorization" ? value : null;

describe("checkOperatorToken (legacy bearer, AUTH-001 closed semantics)", () => {
  it("denies everything when no token is configured (empty never means open)", () => {
    expect(checkOperatorToken(header(null), "")).toBe(false);
    expect(checkOperatorToken(header("Bearer x"), "")).toBe(false);
    expect(checkOperatorToken(header("Bearer "), "")).toBe(false);
  });

  it("requires an exact Bearer match when configured", () => {
    expect(checkOperatorToken(header("Bearer s3cret"), "s3cret")).toBe(true);
    expect(checkOperatorToken(header(null), "s3cret")).toBe(false);
    expect(checkOperatorToken(header("Bearer wrong"), "s3cret")).toBe(false);
    expect(checkOperatorToken(header("bearer s3cret"), "s3cret")).toBe(false);
    expect(checkOperatorToken(header("Bearer s3cret "), "s3cret")).toBe(false);
  });
});

describe("checkServiceToken", () => {
  it("is closed when unconfigured and exact when configured", () => {
    expect(checkServiceToken(header(null), "")).toBe(false);
    expect(checkServiceToken(header("Bearer anything"), "")).toBe(false);
    expect(checkServiceToken(header("Bearer tok"), "tok")).toBe(true);
    expect(checkServiceToken(header("Bearer tok"), "other")).toBe(false);
    expect(checkServiceToken(header(null), "tok")).toBe(false);
    expect(checkServiceToken(header("Token tok"), "tok")).toBe(false);
  });
});

describe("checkSameOrigin (CSRF)", () => {
  const h = (origin: string | null, referer: string | null) => (n: string) =>
    n === "origin" ? origin : n === "referer" ? referer : null;
  it("accepts matching Origin or Referer, rejects everything else", () => {
    expect(checkSameOrigin(h("http://127.0.0.1:3101/x", null), "127.0.0.1:3101")).toBe(true);
    expect(checkSameOrigin(h(null, "http://127.0.0.1:3101/review"), "127.0.0.1:3101")).toBe(true);
    expect(checkSameOrigin(h(null, null), "127.0.0.1:3101")).toBe(false);
    expect(checkSameOrigin(h("https://evil.example/", null), "127.0.0.1:3101")).toBe(false);
    expect(checkSameOrigin(h(null, "https://evil.example/login"), "127.0.0.1:3101")).toBe(false);
    expect(checkSameOrigin(h("http://127.0.0.1:9999/", null), "127.0.0.1:3101")).toBe(false);
    expect(checkSameOrigin(h("not a url", null), "127.0.0.1:3101")).toBe(false);
    expect(checkSameOrigin(h("http://127.0.0.1:3101/", null), "")).toBe(false);
    expect(checkSameOrigin(h("http://127.0.0.1:3101/", null), null)).toBe(false);
  });
});

describe("safeNextPath (open-redirect guard)", () => {
  it("allows same-origin absolute paths and neutralizes everything else", () => {
    expect(safeNextPath("/review")).toBe("/review");
    expect(safeNextPath("/briefs/BR-2026-001?q=1")).toBe("/briefs/BR-2026-001?q=1");
    expect(safeNextPath("/")).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(42)).toBe("/");
    expect(safeNextPath("https://evil.example/")).toBe("/");
    expect(safeNextPath("//evil.example/")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("javascript:alert(1)")).toBe("/");
    expect(safeNextPath("/review\r\nSet-Cookie: x")).toBe("/");
    expect(safeNextPath("review")).toBe("/");
    const bounded = safeNextPath("/a".repeat(1000));
    expect(bounded.length).toBeLessThanOrEqual(500);
    expect(bounded.startsWith("/a")).toBe(true);
  });
});

describe("clientIp", () => {
  it("prefers the first forwarded address and defaults to local", () => {
    const h = (v: string | null) => (n: string) => (n === "x-forwarded-for" ? v : null);
    expect(clientIp(h("1.2.3.4, 5.6.7.8"))).toBe("1.2.3.4");
    expect(clientIp(h(null))).toBe("local");
    expect(clientIp(h(""))).toBe("local");
  });
});

describe("auth config (fail-closed)", () => {
  it("is unconfigured without a credential and clamps numeric tuning", () => {
    const c = getAuthConfig({ ...process.env, OPERATOR_EMAIL: "", OPERATOR_PASSWORD_HASH: "" } as NodeJS.ProcessEnv);
    expect(c.configured).toBe(false);
    expect(c.devOpen).toBe(false);
    expect(c.serviceToken).toBe("");
    const clamped = getAuthConfig({
      ...process.env,
      AUTH_SESSION_TTL_SEC: "1",
      AUTH_SESSION_MAX_SEC: "999999999",
      AUTH_LOGIN_MAX_ATTEMPTS: "0",
    } as NodeJS.ProcessEnv);
    expect(clamped.sessionTtlSec).toBe(300);
    expect(clamped.sessionMaxSec).toBe(30 * 24 * 3600);
    expect(clamped.loginMaxAttempts).toBe(1);
  });

  it("rejects malformed or .env-mangled hashes as unconfigured (fail closed)", () => {
    const base = { ...process.env, OPERATOR_EMAIL: "op@example.com" } as NodeJS.ProcessEnv;
    // Mangled by Next.js $VAR expansion inside .env (the real incident behind this test).
    expect(
      getAuthConfig({ ...base, OPERATOR_PASSWORD_HASH: "scrypt6384/K5HIRaZa3xwbD" }).configured,
    ).toBe(false);
    expect(getAuthConfig({ ...base, OPERATOR_PASSWORD_HASH: "not-a-hash" }).configured).toBe(false);
    expect(getAuthConfig({ ...base, OPERATOR_PASSWORD_HASH: "scrypt$1$2" }).configured).toBe(false);
    expect(
      getAuthConfig({
        ...base,
        OPERATOR_PASSWORD_HASH: "scrypt$16384$8$1$c2FsdA==$a2V5MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=",
      }).configured,
    ).toBe(true);
  });

  it("ignores AUTH_DEV_OPEN in production and fails closed there", () => {
    const prod = getAuthConfig({
      ...process.env,
      NODE_ENV: "production",
      AUTH_DEV_OPEN: "1",
      OPERATOR_EMAIL: "",
      OPERATOR_PASSWORD_HASH: "",
      OPERATOR_API_TOKEN: "",
    } as NodeJS.ProcessEnv);
    expect(prod.devOpen).toBe(false);
    expect(() => assertAuthAvailable(prod)).toThrow("auth_not_configured");
    // Non-production never throws (local dev may provision later).
    expect(() =>
      assertAuthAvailable(getAuthConfig({ ...process.env, NODE_ENV: "test" } as NodeJS.ProcessEnv)),
    ).not.toThrow();
    // Production with a credential (or an explicit service token) is fine.
    const prodOk = getAuthConfig({
      ...process.env,
      NODE_ENV: "production",
      OPERATOR_EMAIL: "op@example.com",
      OPERATOR_PASSWORD_HASH: "scrypt$16384$8$1$c2FsdA==$a2V5MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=",
    } as NodeJS.ProcessEnv);
    expect(() => assertAuthAvailable(prodOk)).not.toThrow();
  });

  it("enables the isolated dev bypass only outside production", () => {
    const dev = getAuthConfig({
      ...process.env,
      NODE_ENV: "test",
      AUTH_DEV_OPEN: "1",
    } as NodeJS.ProcessEnv);
    expect(dev.devOpen).toBe(true);
  });
});

describe("password hashing (scrypt)", () => {
  it("hashes and verifies; wrong passwords and malformed hashes fail", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
    expect(await verifyPassword("correct horse battery staple", "not-a-hash")).toBe(false);
    expect(await verifyPassword("correct horse battery staple", "scrypt$1$1$1$zz$zz")).toBe(false);
    // Salts differ: same password yields different hashes.
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  }, 30000);

  it("provides a dummy hash that never verifies a real password", async () => {
    const d = await getDummyHash();
    expect(await verifyPassword("anything", d)).toBe(false);
    expect(await getDummyHash()).toBe(d);
  }, 30000);
});

describe("email normalization", () => {
  it("trims, lowercases, and validates plausibility", () => {
    expect(normalizeEmail("  Op@Example.COM ")).toBe("op@example.com");
    expect(normalizeEmail(null)).toBe("");
    expect(normalizeEmail(42)).toBe("");
    expect(isPlausibleEmail("op@example.com")).toBe(true);
    expect(isPlausibleEmail("a@b.co")).toBe(true);
    expect(isPlausibleEmail("no-at-sign")).toBe(false);
    expect(isPlausibleEmail("a@b")).toBe(false);
    expect(isPlausibleEmail("@example.com")).toBe(false);
    expect(isPlausibleEmail("a@@b.com")).toBe(false);
    expect(isPlausibleEmail("a@b.com ")).toBe(false);
    expect(isPlausibleEmail("")).toBe(false);
  });
});

describe("login rate limiting", () => {
  it("locks after N failures, clears on success, resets for tests", () => {
    _resetRateLimit();
    const cfg = { maxAttempts: 3, windowSec: 600, lockSec: 600 };
    const key = rateLimitKey("local", "op@example.com");
    expect(checkRateLimit(key, cfg, 1000)).toBe(null);
    recordFailure(key, cfg, 1000);
    recordFailure(key, cfg, 2000);
    expect(checkRateLimit(key, cfg, 3000)).toBe(null);
    recordFailure(key, cfg, 3000);
    const remaining = checkRateLimit(key, cfg, 3000);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(600);
    // Lock expires.
    expect(checkRateLimit(key, cfg, 3000 + 601 * 1000)).toBe(null);
    // Success clears.
    recordFailure(key, cfg, 4000);
    recordSuccess(key);
    expect(checkRateLimit(key, cfg, 4000)).toBe(null);
    _resetRateLimit();
  });

  it("keys are per ip+email and case-insensitive", () => {
    expect(rateLimitKey("LOCAL", "OP@Example.com")).toBe(rateLimitKey("local", "op@example.com"));
    expect(rateLimitKey("a", "x@y.z")).not.toBe(rateLimitKey("b", "x@y.z"));
  });
});
