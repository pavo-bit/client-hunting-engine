/**
 * MILESTONE 3 ops tests (local Docker PostgreSQL only, loopback guard).
 *
 * Covers: health-endpoint shape + privacy, decision-log redaction, middleware
 * redaction-by-construction (static) + matcher, boot validation fail-closed,
 * and the REAL backup workflow end to end (backup -> verify -> restore into
 * scratch -> refusal paths -> artifact cleanup). The backup test shells out
 * to scripts/backup.mjs against the real container: slow (~15s) but honest —
 * it exercises docker exec, pg_dump/pg_restore, manifests, and scratch
 * lifecycle, not mocks of them.
 */
import { execFileSync, spawnSync } from "child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as healthGET } from "../app/api/health/route";
import { logDecision, reqIdOf } from "../lib/ops/http-log";

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
process.env.DATABASE_URL = DB_URL;
const ROOT = process.cwd();
const pool = new Pool({ connectionString: DB_URL, max: 2 });

function backup(args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, "scripts", "backup.mjs"), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}` };
  }
}

afterAll(async () => {
  await pool.end();
});

describe("health endpoint", () => {
  it("reports liveness + db readiness with no private data", async () => {
    const res = await healthGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    const db = body.db as Record<string, unknown>;
    expect(db.ok).toBe(true);
    expect(typeof db.latencyMs).toBe("number");
    // Privacy: fixed narrow shape, nothing else.
    expect(Object.keys(body).sort()).toEqual(["db", "status"]);
    expect(Object.keys(db).sort()).toEqual(["latencyMs", "ok"]);
    const text = JSON.stringify(body);
    for (const forbidden of ["password", "token", "secret", "cookie", "session", "operator@", "company", "claim"]) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe("observability redaction", () => {
  it("decision logs carry only the fixed narrow shape", () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: string) => {
      lines.push(String(s));
    };
    try {
      logDecision({ event: "auth", outcome: "denied", route: "/api/companies", reqId: "abc-123", ms: 4 });
      logDecision({ event: "login", outcome: "success", route: "/api/auth/login", reqId: "none", ms: 90 });
    } finally {
      console.log = orig;
    }
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const rec = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(rec).sort()).toEqual(["event", "ms", "outcome", "reqId", "route"]);
    }
    const text = lines.join(" ");
    for (const forbidden of ["password", "hash", "token", "cookie", "secret", "bearer", "email", "@"]) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("accepts well-formed request ids and neutralizes anything else", () => {
    const h = (v: string | null) => ({ headers: { get: () => v } }) as unknown as Request;
    expect(reqIdOf(h("550e8400-e29b-41d4-a716-446655440000"))).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(reqIdOf(h(null))).toBe("none");
    expect(reqIdOf(h("x".repeat(500)))).toBe("none");
    expect(reqIdOf(h("<script>alert(1)</script>"))).toBe("none");
  });

  it("middleware observes method+path only (static redaction proof)", () => {
    const raw = readFileSync(join(ROOT, "middleware.ts"), "utf8");
    // Strip comments: documentation may name the things code must not touch.
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");
    expect(src).toMatch(/x-request-id/);
    expect(src).toMatch(/matcher/);
    for (const forbidden of ["cookie", "authorization", "password", "token", "secret", "process.env", ".searchParams", "request.json", ".text()", ".arrayBuffer"]) {
      expect(src.toLowerCase(), `middleware must not touch ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("boot validation", () => {
  it("refuses production boot without secrets (fail closed)", async () => {
    const env = process.env as Record<string, string | undefined>;
    const saved: Record<string, string | undefined> = {
      NODE_ENV: env.NODE_ENV,
      NEXT_RUNTIME: env.NEXT_RUNTIME,
      OPERATOR_EMAIL: env.OPERATOR_EMAIL,
      OPERATOR_PASSWORD_HASH: env.OPERATOR_PASSWORD_HASH,
      OPERATOR_API_TOKEN: env.OPERATOR_API_TOKEN,
    };
    env.NODE_ENV = "production";
    env.NEXT_RUNTIME = "nodejs";
    delete env.OPERATOR_EMAIL;
    delete env.OPERATOR_PASSWORD_HASH;
    delete env.OPERATOR_API_TOKEN;
    try {
      const { register } = await import("../instrumentation");
      await expect(register()).rejects.toThrow("auth_not_configured");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
    }
  });
});

describe("backup workflow end to end (real container, scratch targets)", () => {
  const created: string[] = [];
  // The backup filename derives from the target database name, which varies
  // (agency_intel_test locally, agency_intel_ci in CI simulation).
  const dbName = new URL(DB_URL).pathname.replace(/^\//, "");
  const prefix = `${dbName}-`;

  // EXPLICIT PREREQUISITE (Phase 4 / A3).
  //
  // The real workflow shells into a PostgreSQL container, so it can only run
  // where that infrastructure exists. Previously the container name was an
  // implicit assumption (`grayscales-pg`), so the suite failed obscurely on a
  // host without that container and could silently be meaningless in CI,
  // where the postgres service container has no such name.
  //
  // The name is now configuration (BACKUP_CONTAINER, defaulting to the
  // project's compose name), and the check below is about INFRASTRUCTURE ONLY:
  // no docker CLI, or no running container of that name. If the infrastructure
  // is present the tests run and may still fail on a real defect — a genuine
  // failure is never converted into a skip.
  const container = process.env.BACKUP_CONTAINER ?? "grayscales-pg";
  const prereq = ((): { ok: boolean; reason: string } => {
    const which = spawnSync("docker", ["--version"], { encoding: "utf8" });
    if (which.error || which.status !== 0)
      return { ok: false, reason: "docker CLI is not available on this host" };
    const inspect = spawnSync(
      "docker",
      ["inspect", "-f", "{{.State.Running}}", container],
      { encoding: "utf8" },
    );
    if (inspect.error || inspect.status !== 0)
      return {
        ok: false,
        reason: `container '${container}' is not present (start it, or set BACKUP_CONTAINER)`,
      };
    if (inspect.stdout.trim() !== "true")
      return { ok: false, reason: `container '${container}' exists but is not running` };
    return { ok: true, reason: "docker and the configured container are available" };
  })();

  if (!prereq.ok)
    console.warn(`[milestone3_ops] backup/restore tests SKIPPED: ${prereq.reason}`);
  const itWithInfra = prereq.ok ? it : it.skip;

  itWithInfra("backs up, verifies, and restores with integrity", async () => {
    const b = backup(["backup", "--target=test"]);
    expect(b.ok, b.out).toBe(true);
    expect(b.out).toContain("backup ok:");
    const files = readdirSync(join(ROOT, "backups"))
      .filter((f) => f.startsWith(prefix) && f.endsWith(".dump"))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    const newest = files[files.length - 1];
    created.push(join(ROOT, "backups", newest), join(ROOT, "backups", `${newest}.manifest.json`));

    const manifest = JSON.parse(
      readFileSync(join(ROOT, "backups", `${newest}.manifest.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest.database).toBe(dbName);
    expect(manifest.format).toContain("pg_dump -Fc");
    expect(Number(manifest.bytes)).toBeGreaterThan(1024);
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(manifest)).not.toMatch(/postgres:postgres|PGPASSWORD|password/i);

    const v = backup(["verify", join(ROOT, "backups", newest)]);
    expect(v.ok, v.out).toBe(true);
    expect(v.out).toContain("verify ok:");

    const scratch = "agency_intel_restore_m3t";
    const r = backup(["restore", join(ROOT, "backups", newest), "--scratch", scratch]);
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toContain("integrity ok:");
    // Default restores clean up after themselves.
    const c = await pool.connect();
    try {
      const gone = await c.query("select count(*)::int as n from pg_database where datname = $1", [scratch]);
      expect(gone.rows[0].n).toBe(0);
    } finally {
      c.release();
    }
  }, 300000);

  itWithInfra("refuses invalid artifacts, protected names, and existing targets", async () => {
    const bad = backup(["verify", join(ROOT, "tests", "fixtures", "gleif", "search-ok.json")]);
    expect(bad.ok).toBe(false);
    const badRestore = backup(["restore", join(ROOT, "tests", "fixtures", "gleif", "search-ok.json"), "--scratch", "agency_intel_restore_m3bad"]);
    expect(badRestore.ok).toBe(false);
    const c = await pool.connect();
    try {
      const left = await c.query("select count(*)::int as n from pg_database where datname = 'agency_intel_restore_m3bad'");
      expect(left.rows[0].n, "failed restores leave nothing behind").toBe(0);
    } finally {
      c.release();
    }
    // Protected names are refused without touching anything.
    const prot = backup(["restore", join(ROOT, "tests", "fixtures", "gleif", "search-ok.json"), "--scratch", "agency_intel_test"]);
    expect(prot.ok).toBe(false);
    expect(prot.out).toContain("protected");
  }, 300000);

  it("leaves no backup artifacts behind", () => {
    for (const f of created) {
      if (existsSync(f)) rmSync(f);
    }
    const leftovers = readdirSync(join(ROOT, "backups")).filter((f) => f.startsWith(prefix));
    expect(leftovers).toEqual([]);
  });
});

