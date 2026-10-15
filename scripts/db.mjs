// Minimal migration runner (Node + pg). No Supabase, no extra dependencies.
// Usage:
//   node scripts/db.mjs bootstrap [--target dev|test]   # databases + noaccess role
//   node scripts/db.mjs migrate    [--target dev|test]  # ordered *.sql, recorded
//   node scripts/db.mjs seed       [--target dev]       # deterministic seed
//   node scripts/db.mjs verify     [--target dev]       # t002 assertion suite
// Env: .env is loaded (lowest precedence). Targets resolve to DATABASE_URL
// (dev) or TEST_DATABASE_URL (test). Destructive only to the configured
// local target; refuses non-loopback hosts.
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- tiny .env loader (KEY=VALUE, # comments) ---
try {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* no .env — env must supply URLs */
}

const DEV_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel";
const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";

function targetUrl(target) {
  const url = target === "test" ? TEST_URL : DEV_URL;
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.error(`refusing non-local database target: ${host}`);
    process.exit(2);
  }
  return url;
}

function maintUrl(url) {
  const u = new URL(url);
  u.pathname = "/postgres";
  return u.toString();
}

const qlit = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function bootstrap(target) {
  const url = targetUrl(target);
  const admin = new pg.Client({ connectionString: maintUrl(url) });
  await admin.connect();
  try {
    const dbName = new URL(url).pathname.replace(/^\//, "");
    const exists = await admin.query("select 1 from pg_database where datname = $1", [dbName]);
    if (exists.rows.length === 0) {
      await admin.query(`create database "${dbName.replace(/"/g, "")}"`);
      console.log(`created database ${dbName}`);
    } else {
      console.log(`database ${dbName} exists`);
    }
    const role = process.env.APP_NOACCESS_USER ?? "noaccess";
    const pw = process.env.APP_NOACCESS_PASSWORD ?? "noaccess-local-only";
    await admin.query(
      `do $$ begin if not exists (select from pg_roles where rolname = ${qlit(role)}) then ` +
        `create role ${role} login; end if; end $$;`,
    );
    // NOTE: role names come from local env; identifier cannot be parameterized.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(role)) throw new Error("bad role name");
    await admin.query(`alter role ${role} with password ${qlit(pw)} login`);
    await admin.query(`grant connect on database "${dbName.replace(/"/g, "")}" to ${role}`);
    console.log(`role ${role} ready (CONNECT only, no table grants)`);

    // Phase 2 principal. Same treatment as `noaccess`: a LOGIN role that holds
    // NO table grants until migration M10 grants it exactly the approved
    // qualification view and the two scoped consumption functions. Created
    // here (not in a migration) because role creation is a cluster operation,
    // not a schema change.
    const p2 = process.env.APP_P2_USER ?? "p2_app";
    const p2pw = process.env.APP_P2_PASSWORD ?? "p2-app-local-only";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p2)) throw new Error("bad phase-2 role name");
    await admin.query(
      `do $$ begin if not exists (select from pg_roles where rolname = ${qlit(p2)}) then ` +
        `create role ${p2} login; end if; end $$;`,
    );
    await admin.query(`alter role ${p2} with password ${qlit(p2pw)} login`);
    await admin.query(`grant connect on database "${dbName.replace(/"/g, "")}" to ${p2}`);
    console.log(`role ${p2} ready (CONNECT only; grants come from migration M10)`);
  } finally {
    await admin.end();
  }
}

async function migrate(target) {
  const client = new pg.Client({ connectionString: targetUrl(target) });
  await client.connect();
  try {
    await client.query(
      `create table if not exists public.schema_migrations (
         version text primary key, applied_at timestamptz not null default now())`,
    );
    const done = new Set(
      (await client.query("select version from public.schema_migrations")).rows.map((r) => r.version),
    );
    const files = readdirSync(join(ROOT, "db", "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    let applied = 0;
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(ROOT, "db", "migrations", f), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into public.schema_migrations (version) values ($1)", [f]);
        await client.query("commit");
        applied += 1;
        console.log(`applied ${f}`);
      } catch (e) {
        await client.query("rollback");
        throw e;
      }
    }
    console.log(applied === 0 ? "already up to date" : `applied ${applied} migration(s)`);
  } finally {
    await client.end();
  }
}

async function runFile(target, rel, label) {
  const client = new pg.Client({ connectionString: targetUrl(target) });
  await client.connect();
  try {
    await client.query(readFileSync(join(ROOT, rel), "utf8"));
    console.log(`${label} ok: ${rel}`);
  } finally {
    await client.end();
  }
}

const args = process.argv.slice(2);
const cmd = args[0];
const target = args.includes("test") || args.some((a) => a === "--target=test") ? "test" : "dev";

try {
  if (cmd === "bootstrap") await bootstrap(target);
  else if (cmd === "migrate") await migrate(target);
  else if (cmd === "seed") await runFile(target, join("db", "seed.sql"), "seed");
  else if (cmd === "verify") await runFile(target, join("db", "tests", "t002_verify.sql"), "verify");
  else {
    console.error("usage: node scripts/db.mjs <bootstrap|migrate|seed|verify> [--target dev|test]");
    process.exit(2);
  }
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
}
