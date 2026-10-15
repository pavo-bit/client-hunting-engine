/**
 * R-03 seed compatibility + idempotency tests.
 *
 * The seed must run on a FULLY MIGRATED database, twice, without duplicating or
 * corrupting demo rows, and an induced failure must roll back completely.
 *
 * Isolation: these tests NEVER touch the development database. They create
 * throwaway scratch databases on the same local cluster, drive them through the
 * real `scripts/db.mjs` runner, and drop them afterwards. Dropping only ever
 * targets the fixed names below, and every URL is asserted loopback first.
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { Client } = pg;

const ADMIN_URL =
  process.env.TEST_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
const SEEDED_DB = "agency_intel_seedtest_ok";
const ROLLBACK_DB = "agency_intel_seedtest_rb";

for (const u of [ADMIN_URL]) {
  if (!/127\.0\.0\.1|localhost/.test(new URL(u).hostname)) {
    throw new Error("refusing non-local database");
  }
}
const SCRATCH_URLS = [SEEDED_DB, ROLLBACK_DB].map(
  (db) => `postgresql://postgres:postgres@127.0.0.1:5434/${db}`,
);
for (const u of SCRATCH_URLS) {
  if (!/127\.0\.0\.1|localhost/.test(new URL(u).hostname)) {
    throw new Error("refusing non-local database");
  }
}

const ROOT = process.cwd();
const SEED_SQL = readFileSync(join(ROOT, "db", "seed.sql"), "utf8");
const MIGRATION_COUNT = 44;
const HYPOTHESIS_LIFECYCLE = [
  "generated",
  "needs_review",
  "deferred",
  "rejected",
  "validated",
  "superseded",
];

/** Tables the seed writes, with the row counts a correct seed must produce. */
const SEED_TABLES: Record<string, number> = {
  company: 3,
  discovery_record: 4,
  research_run: 2,
  snapshot: 2,
  claim: 5,
  hypothesis: 1,
  hypothesis_evidence: 4,
  capability: 2,
  project_option: 1,
  project_capability: 1,
  score_run: 1,
  brief: 1,
  outreach_draft: 1,
  outcome_log: 1,
  audit_log: 2,
  failure_log: 1,
};

function run(cmd: string, env: Record<string, string | undefined>): string {
  return execFileSync(process.execPath, [join(ROOT, "scripts", "db.mjs"), cmd, "--target", "test"], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function admin(sql: string): Promise<void> {
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

async function dropScratch(): Promise<void> {
  for (const db of [SEEDED_DB, ROLLBACK_DB]) {
    await admin(
      `drop database if exists "${db}" with (force);`,
    );
  }
}

async function counts(url: string): Promise<Record<string, number>> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const out: Record<string, number> = {};
    for (const table of Object.keys(SEED_TABLES)) {
      const r = await c.query<{ n: number }>(`select count(*)::int as n from public.${table}`);
      out[table] = r.rows[0].n;
    }
    return out;
  } finally {
    await c.end();
  }
}

let afterFirstSeed: Record<string, number> = {};
let afterThirdSeed: Record<string, number> = {};
let migrationsApplied = "";
let verifyOut = "";

beforeAll(async () => {
  await dropScratch();
  // 1) Fresh, fully migrated, EMPTY database.
  run("bootstrap", { TEST_DATABASE_URL: SCRATCH_URLS[0] });
  migrationsApplied = run("migrate", { TEST_DATABASE_URL: SCRATCH_URLS[0] });
  // 2) Seed run #1.
  run("seed", { TEST_DATABASE_URL: SCRATCH_URLS[0] });
  afterFirstSeed = await counts(SCRATCH_URLS[0]);
  // 3) Seed runs #2 and #3 must be no-ops.
  run("seed", { TEST_DATABASE_URL: SCRATCH_URLS[0] });
  run("seed", { TEST_DATABASE_URL: SCRATCH_URLS[0] });
  afterThirdSeed = await counts(SCRATCH_URLS[0]);
  // 4) Verification suite on the freshly seeded database.
  verifyOut = run("verify", { TEST_DATABASE_URL: SCRATCH_URLS[0] });
}, 300_000);

afterAll(async () => {
  await dropScratch();
}, 120_000);

describe("R-03 seed compatibility on a fully migrated database", () => {
  it("applies every migration to a fresh database", () => {
    expect(migrationsApplied).toContain(`applied ${MIGRATION_COUNT} migration(s)`);
  });

  it("seeds successfully and produces exactly the intended demo rows", () => {
    expect(afterFirstSeed).toEqual(SEED_TABLES);
  });

  it("is idempotent: two further runs duplicate nothing and corrupt nothing", () => {
    expect(afterThirdSeed, "row counts must be identical after 3 seed runs").toEqual(afterFirstSeed);
    expect(afterThirdSeed).toEqual(SEED_TABLES);
  });

  it("keeps every seeded hypothesis status valid under the current lifecycle", async () => {
    const c = new Client({ connectionString: SCRATCH_URLS[0] });
    await c.connect();
    try {
      const h = await c.query<{ status: string }>("select status from public.hypothesis");
      expect(h.rows.length).toBe(1);
      for (const row of h.rows) {
        expect(HYPOTHESIS_LIFECYCLE, `illegal status ${row.status}`).toContain(row.status);
      }
      // No obsolete lifecycle vocabulary may be USED as a value. Comments are
      // stripped first: the R-03 note in seed.sql explains the old mapping.
      const seedStatementsOnly = SEED_SQL.replace(/--[^\n]*/g, "");
      for (const legacy of ["evidenced", "proposed", "stale"]) {
        expect(seedStatementsOnly, `seed must not use '${legacy}' as a value`).not.toContain(
          `'${legacy}'`,
        );
      }
      // And nothing left in the database may carry a legacy status.
      const legacyRows = await c.query<{ n: number }>(
        "select count(*)::int as n from public.hypothesis where status not in ($1,$2,$3,$4,$5,$6)",
        HYPOTHESIS_LIFECYCLE,
      );
      expect(legacyRows.rows[0].n).toBe(0);
      // The demo record keeps its evidence-driven meaning: 3 supports + 1 contradicts.
      const e = await c.query<{ polarity: string; n: number }>(
        "select polarity, count(*)::int as n from public.hypothesis_evidence group by polarity order by polarity",
      );
      expect(e.rows).toEqual([
        { polarity: "contradicts", n: 1 },
        { polarity: "supports", n: 3 },
      ]);
    } finally {
      await c.end();
    }
  }, 60_000);

  it("keeps required relationships consistent after re-seeding", async () => {
    const c = new Client({ connectionString: SCRATCH_URLS[0] });
    await c.connect();
    try {
      const orphans = await c.query<{ n: number }>(`
        select (
          (select count(*) from public.claim cl
             left join public.snapshot s on s.id = cl.snapshot_id
             left join public.source so on so.key = s.source_key
            where s.id is null or so.key is null)
          + (select count(*) from public.hypothesis_evidence he
              join public.hypothesis h on h.id = he.hypothesis_id
              join public.claim cl on cl.id = he.claim_id
             where h.company_id <> cl.company_id)
          + (select count(*) from public.brief b
              join public.hypothesis h on h.id = b.hypothesis_id
             where b.company_id <> h.company_id)
          + (select count(*) from public.project_option p
              left join public.hypothesis h on h.id = p.hypothesis_id
             where h.id is null)
        )::int as n`);
      expect(orphans.rows[0].n, "no orphaned or cross-company demo rows").toBe(0);

      const chain = await c.query<{ n: number }>(`
        select count(*)::int as n
        from public.brief b
        join public.hypothesis h on h.id = b.hypothesis_id
        join public.company co on co.id = b.company_id
        join public.score_run s on s.id = b.score_run_id
        join public.outreach_draft o on o.brief_ref = b.ref
        join public.outcome_log ol on ol.brief_ref = b.ref
        where h.company_id = b.company_id and s.hypothesis_id = h.id
          and o.is_human_send_only`);
      expect(chain.rows[0].n, "company -> hypothesis -> score -> brief -> draft -> outcome").toBe(1);

      // The project_option hangs off the same hypothesis (its link to the brief
      // is intentionally NULL: the seed predates brief.proposal_id, added in
      // migration 20261013000015. See the R-03 report - not repaired here).
      const proj = await c.query<{ n: number }>(
        "select count(*)::int as n from public.project_option p join public.hypothesis h on h.id = p.hypothesis_id",
      );
      expect(proj.rows[0].n).toBe(1);
    } finally {
      await c.end();
    }
  }, 60_000);

  it("keeps the R-02 source invariant: 12 categories, connectors counted separately", async () => {
    const c = new Client({ connectionString: SCRATCH_URLS[0] });
    await c.connect();
    try {
      const s = await c.query<{ categories: number; connectors: number; total: number }>(
        `select count(*) filter (where kind = 'category')::int as categories,
                count(*) filter (where kind = 'connector')::int as connectors,
                count(*)::int as total
         from public.source`,
      );
      expect(s.rows[0].categories).toBe(12);
      expect(s.rows[0].connectors).toBeGreaterThanOrEqual(1);
      expect(s.rows[0].total).toBe(s.rows[0].categories + s.rows[0].connectors);
      const gleif = await c.query("select 1 from public.source where key = 'gleif-api' and kind = 'connector'");
      expect(gleif.rows).toHaveLength(1);
    } finally {
      await c.end();
    }
  }, 60_000);

  it("leaves `node scripts/db.mjs verify` green after seeding", () => {
    expect(verifyOut).toContain("verify ok");
  });

  it("rolls back completely when a seed statement fails", async () => {
    // A second migrated database that is deliberately left UNSEEDED.
    run("bootstrap", { TEST_DATABASE_URL: SCRATCH_URLS[1] });
    run("migrate", { TEST_DATABASE_URL: SCRATCH_URLS[1] });
    const before = await counts(SCRATCH_URLS[1]);
    for (const t of Object.keys(SEED_TABLES)) expect(before[t], `${t} must start empty`).toBe(0);

    // Same execution path as the runner: one simple-query batch. The appended
    // statement violates a CHECK (info_credibility must be 1..5), so the whole
    // batch must abort.
    const poisoned = `${SEED_SQL}\ninsert into public.claim (id, company_id, snapshot_id, claim_text, claim_status, source_reliability, info_credibility)
  values ('ffffffff-ffff-4000-8000-ffffffffffff','11111111-1111-4000-8000-111111111111',
          'c2c2c2c2-c2c2-4000-8000-c2c2c2c2c2c2','poison','disputed','B',99);\n`;
    const c = new Client({ connectionString: SCRATCH_URLS[1] });
    await c.connect();
    let threw = false;
    try {
      await c.query(poisoned);
    } catch (e: unknown) {
      threw = true;
      expect((e as { code?: string }).code).toBe("23514"); // check_violation
    } finally {
      await c.end();
    }
    expect(threw, "the induced failure must surface").toBe(true);

    const after = await counts(SCRATCH_URLS[1]);
    for (const t of Object.keys(SEED_TABLES)) {
      expect(after[t], `${t} must be unchanged (rolled back)`).toBe(0);
    }

    // The database is still usable afterwards: a clean seed now succeeds.
    run("seed", { TEST_DATABASE_URL: SCRATCH_URLS[1] });
    const recovered = await counts(SCRATCH_URLS[1]);
    expect(recovered).toEqual(SEED_TABLES);
  }, 300_000);

  it("never wraps the seed in an explicit transaction (relies on atomic batch)", () => {
    // The runner sends the file as one simple-query batch, which PostgreSQL
    // wraps in a single implicit transaction. An explicit COMMIT in the middle
    // would break the rollback guarantee this suite depends on.
    expect(SEED_SQL.toLowerCase()).not.toMatch(/^\s*(begin|commit|rollback)\s*;/m);
  });

  it("leaves the development seed data untouched", async () => {
    const devUrl = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel";
    if (!/127\.0\.0\.1|localhost/.test(new URL(devUrl).hostname)) {
      throw new Error("refusing non-local database");
    }
    // These tests must never have targeted the dev database in the first place.
    for (const u of SCRATCH_URLS) expect(u).not.toBe(devUrl);
    const devName = new URL(devUrl).pathname.replace(/^\//, "");
    for (const db of [SEEDED_DB, ROLLBACK_DB]) expect(db).not.toBe(devName);

    // The dev database still holds its own seed data, unmodified.
    //
    // Asserted BY IDENTITY, not by global counts: dev is a live working
    // database, and legitimate operator use (a real discovery refresh) adds
    // rows that are none of the seed's business. The invariant under test is
    // "the tests never touched dev and the seed's own records are intact",
    // which is strictly stronger than counting rows.
    const c = new Client({ connectionString: devUrl });
    await c.connect();
    try {
      const r = await c.query<{
        name: string;
        domain_norm: string;
        claims: number;
        hypotheses: number;
      }>(
        `select co.name, co.domain_norm,
                (select count(*)::int from public.claim cl where cl.company_id = co.id) as claims,
                (select count(*)::int from public.hypothesis h where h.company_id = co.id) as hypotheses
         from public.company co
         where co.id in (
           '11111111-1111-4000-8000-111111111111',
           '22222222-2222-4000-8000-222222222222',
           '33333333-3333-4000-8000-333333333333'
         )
         order by co.name`,
      );
      expect(r.rows).toHaveLength(3);
      expect(r.rows).toEqual([
        { name: "Acme Webworks", domain_norm: "acme-webworks.example", claims: 5, hypotheses: 1 },
        { name: "Globex Digital Studio", domain_norm: "globex-digital.example", claims: 0, hypotheses: 0 },
        { name: "Initech Mobile Lab", domain_norm: "initech-mobile.example", claims: 0, hypotheses: 0 },
      ]);
      // The seeded hypothesis is still exactly the one R-03 described.
      const h = await c.query(
        "select status from public.hypothesis where company_id = '11111111-1111-4000-8000-111111111111'",
      );
      expect(h.rows.map((x) => x.status)).toEqual(["needs_review"]);
    } finally {
      await c.end();
    }
  }, 60_000);
});
