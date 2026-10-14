// MILESTONE 3 backup + restore workflow (local Docker PostgreSQL only).
// Uses the version-matched server tools (pg_dump/pg_restore 17.11) via
// `docker exec` — no host pg tools required, no version-skew risk.
//
// Usage:
//   node scripts/backup.mjs backup [--target dev]
//       -> backups/<db>-YYYYMMDD-HHMMSS.dump + .manifest.json sidecar
//   node scripts/backup.mjs verify <dumpfile>
//       -> recompute sha256 vs manifest + pg_restore --list readability
//   node scripts/backup.mjs restore <dumpfile> --scratch <new-db-name>
//       -> restore into a FRESH scratch database + integrity checks
//   node scripts/backup.mjs restore <dumpfile> --scratch <name> --keep
//       -> same, but leave the scratch database for inspection
//
// Safety rules (fail closed):
//   * loopback targets only; refuses non-local database URLs.
//   * restore target must NOT exist yet and must NOT be a protected name
//     (agency_intel, agency_intel_test, postgres, template*). The active dev
//     database can never be overwritten by this script.
//   * the database password travels via `docker exec -e` (process env of a
//     transient exec, visible only to someone who can already docker-inspect
//     this host — i.e. the operator holding .env). It is NEVER printed,
//     logged, or written to the manifest.
//   * manifests carry timestamp/db/format/bytes/sha256/pg-version/result.
//     No secrets, ever.
import { createHash } from "crypto";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- tiny .env loader (same as scripts/db.mjs; lowest precedence) ---
try {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* no .env — env must supply values */
}

const CONTAINER = process.env.BACKUP_CONTAINER ?? "grayscales-pg";
const BACKUP_DIR = join(ROOT, "backups");
const PROTECTED = new Set(["agency_intel", "agency_intel_test", "postgres", "template0", "template1"]);

function targetUrl(target) {
  const url =
    target === "test"
      ? (process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test")
      : (process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel");
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.error(`refusing non-local database target: ${host}`);
    process.exit(2);
  }
  return url;
}

function dbParams(url) {
  const u = new URL(url);
  return {
    user: decodeURIComponent(u.username || "postgres"),
    db: u.pathname.replace(/^\//, ""),
    // Password stays in memory; passed to docker exec via -e only.
    password: decodeURIComponent(u.password || "postgres"),
  };
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sha256File(path) {
  const h = createHash("sha256");
  h.update(readFileSync(path));
  return h.digest("hex");
}

function dockerExec(password, args, opts = {}) {
  // Password via exec env (-e), never argv, never stdout.
  return spawnSync("docker", ["exec", "-e", `PGPASSWORD=${password}`, CONTAINER, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });
}

async function pgQuery(url, sql, params = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

async function backup(target) {
  const url = targetUrl(target);
  const { user, db, password } = dbParams(url);
  mkdirSync(BACKUP_DIR, { recursive: true });
  const file = join(BACKUP_DIR, `${db}-${stamp()}.dump`);
  const started = new Date().toISOString();

  const r = dockerExec(password, ["pg_dump", "-U", user, "-d", db, "-Fc", "-f", "/tmp/m3.dump"]);
  if (r.status !== 0) {
    console.error(`FAILED: pg_dump exited ${r.status}: ${(r.stderr || "").slice(0, 500)}`);
    process.exit(1);
  }
  const cp = spawnSync("docker", ["cp", `${CONTAINER}:/tmp/m3.dump`, file], { encoding: "utf8" });
  dockerExec(password, ["rm", "-f", "/tmp/m3.dump"]);
  if (cp.status !== 0) {
    console.error(`FAILED: docker cp exited ${cp.status}`);
    process.exit(1);
  }
  const bytes = statSync(file).size;
  if (bytes < 1024) {
    console.error(`FAILED: dump suspiciously small (${bytes} bytes)`);
    process.exit(1);
  }
  // Integrity at backup time: size sanity + sha256 for later comparison.
  // Readability (TOC parse) is proven by `backup.mjs verify` and, fully, by
  // the restore drill — not claimed here.
  const manifest = {
    tool: "scripts/backup.mjs",
    created_at: started,
    database: db,
    target,
    format: "custom (pg_dump -Fc)",
    file: basename(file),
    bytes,
    sha256: sha256File(file),
    postgres: "17.11 (container-matched tools)",
    verification: "size + sha256 recorded; readability proven by restore drill (see manifest of restore) or `backup.mjs verify`",
  };
  writeFileSync(`${file}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`backup ok: ${file} (${bytes} bytes, sha256 ${manifest.sha256.slice(0, 16)}…)`);
  console.log(`manifest: ${file}.manifest.json`);
}

async function verify(file) {
  if (!existsSync(file)) {
    console.error(`FAILED: no such file: ${file}`);
    process.exit(1);
  }
  const manifestPath = `${file}.manifest.json`;
  const actual = sha256File(file);
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.sha256 !== actual) {
      console.error("FAILED: sha256 mismatch — file changed since backup (corrupt or tampered)");
      process.exit(1);
    }
    console.log(`sha256 matches manifest (${actual.slice(0, 16)}…)`);
  } else {
    console.log(`no manifest; computed sha256 ${actual} (legacy artifact, integrity unverifiable against a record)`);
  }
  // Readability: pg_restore --list must parse the TOC. Needs the file inside
  // the container (no host pg tools guaranteed).
  const base = basename(file);
  const cp = spawnSync("docker", ["cp", file, `${CONTAINER}:/tmp/m3verify.dump`], { encoding: "utf8" });
  if (cp.status !== 0) {
    console.error("FAILED: could not stage file into container");
    process.exit(1);
  }
  const r = dockerExec("", ["pg_restore", "--list", "/tmp/m3verify.dump"]);
  dockerExec("", ["rm", "-f", "/tmp/m3verify.dump"]);
  if (r.status !== 0) {
    console.error(`FAILED: pg_restore cannot read TOC: ${(r.stderr || "").slice(0, 300)}`);
    process.exit(1);
  }
  const entries = r.stdout.split("\n").filter((l) => l.trim() && !l.startsWith(";")).length;
  console.log(`TOC readable: ${entries} entries`);
  console.log(`verify ok: ${file}`);
}

async function restore(file, scratch, keep) {
  if (!existsSync(file)) {
    console.error(`FAILED: no such file: ${file}`);
    process.exit(1);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,50}$/.test(scratch || "")) {
    console.error("FAILED: --scratch needs a safe database name (letters/digits/underscore)");
    process.exit(1);
  }
  if (PROTECTED.has(scratch)) {
    console.error(`FAILED: refusing to touch protected database "${scratch}"`);
    process.exit(1);
  }
  const adminUrl = targetUrl("dev");
  const admin = new URL(adminUrl);
  admin.pathname = "/postgres";
  const exists = await pgQuery(admin.toString(), "select 1 from pg_database where datname = $1", [scratch]);
  if (exists.rows.length > 0) {
    console.error(`FAILED: scratch database "${scratch}" already exists (refusing to overwrite; drop it manually first)`);
    process.exit(1);
  }
  const { user, password } = dbParams(adminUrl);
  const t0 = Date.now();
  await pgQuery(admin.toString(), `create database "${scratch.replace(/"/g, "")}"`);
  const dropScratch = async () => {
    try {
      await pgQuery(admin.toString(), `drop database "${scratch.replace(/"/g, "")}"`);
    } catch {
      /* best-effort cleanup */
    }
  };
  const cp = spawnSync("docker", ["cp", file, `${CONTAINER}:/tmp/m3restore.dump`], { encoding: "utf8" });
  if (cp.status !== 0) {
    await dropScratch();
    console.error("FAILED: could not stage file into container");
    process.exit(1);
  }
  const r = dockerExec(password, ["pg_restore", "-U", user, "-d", scratch, "--no-owner", "/tmp/m3restore.dump"]);
  dockerExec(password, ["rm", "-f", "/tmp/m3restore.dump"]);
  if (r.status !== 0) {
    await dropScratch();
    console.error(`FAILED: pg_restore exited ${r.status}: ${(r.stderr || "").slice(0, 500)}`);
    console.error(`scratch database "${scratch}" was dropped again (no partial restore left behind)`);
    process.exit(1);
  }
  // Integrity checks against the restored database (read-only).
  const restoredUrl = new URL(adminUrl);
  restoredUrl.pathname = `/${scratch}`;
  const checks = {
    migrations: Number((await pgQuery(restoredUrl.toString(), "select count(*) as n from public.schema_migrations")).rows[0].n),
    companies: Number((await pgQuery(restoredUrl.toString(), "select count(*) as n from public.company")).rows[0].n),
    claims: Number((await pgQuery(restoredUrl.toString(), "select count(*) as n from public.claim")).rows[0].n),
    source_categories: Number(
      (await pgQuery(restoredUrl.toString(), "select count(*) filter (where kind = 'category') as n from public.source")).rows[0].n,
    ),
    audit_rows: Number((await pgQuery(restoredUrl.toString(), "select count(*) as n from public.audit_log")).rows[0].n),
    orphan_claims: Number(
      (
        await pgQuery(
          restoredUrl.toString(),
          `select count(*) as n from public.claim c
           left join public.snapshot s on s.id = c.snapshot_id
           left join public.source so on so.key = s.source_key
           where s.id is null or so.key is null`,
        )
      ).rows[0].n,
    ),
  };
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`restore ok: ${file} -> ${scratch} in ${secs}s`);
  console.log(`integrity: ${JSON.stringify(checks)}`);
  const problems = [];
  if (checks.migrations < 1) problems.push("no migrations recorded");
  if (checks.source_categories !== 12) problems.push(`source categories = ${checks.source_categories}, want 12`);
  if (checks.orphan_claims !== 0) problems.push(`${checks.orphan_claims} orphan claims`);
  if (problems.length > 0) {
    console.error(`FAILED integrity: ${problems.join("; ")}`);
    process.exit(1);
  }
  console.log("integrity ok: migrations present, 12 source categories, zero orphan claims");
  if (!keep) {
    await pgQuery(admin.toString(), `drop database "${scratch.replace(/"/g, "")}"`);
    console.log(`scratch database "${scratch}" dropped (use --keep to inspect)`);
  } else {
    console.log(`scratch database "${scratch}" KEPT for inspection — drop it manually when done`);
  }
}

const args = process.argv.slice(2);
const cmd = args[0];
try {
  if (cmd === "backup") {
    const target = args.includes("--target=test") || args.includes("test") ? "test" : "dev";
    await backup(target);
  } else if (cmd === "verify") {
    if (!args[1]) throw new Error("usage: node scripts/backup.mjs verify <dumpfile>");
    await verify(args[1]);
  } else if (cmd === "restore") {
    const si = args.indexOf("--scratch");
    if (!args[1] || si === -1) throw new Error("usage: node scripts/backup.mjs restore <dumpfile> --scratch <new-db> [--keep]");
    await restore(args[1], args[si + 1], args.includes("--keep"));
  } else {
    console.error("usage: node scripts/backup.mjs <backup [--target dev|test]|verify <dump>|restore <dump> --scratch <db> [--keep]>");
    process.exit(2);
  }
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
}
