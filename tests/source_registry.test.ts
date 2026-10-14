/**
 * R-02 source-registry invariant tests (local DB only, loopback guard).
 *
 * The locked policy invariant is exactly 12 CATEGORY rows (S-01..S-12).
 * Connector rows (e.g. `gleif-api`, added by T-006) are additional, auditable
 * source records under a category and must NOT change the category count.
 *
 * This mirrors the SQL regression in `db/tests/t002_verify.sql` (block 1b) so
 * the invariant is also enforced by the standard Vitest regression run.
 */
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.T003_TEST_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 2 });

/** The 12 approved source categories. LOCKED by D-000 / SOURCE_INTEGRATION_PLAN. */
const APPROVED_CODES = [
  "S-01", "S-02", "S-03", "S-04", "S-05", "S-06",
  "S-07", "S-08", "S-09", "S-10", "S-11", "S-12",
];

/** Seeded category keys (migration 20261012000002). */
const CATEGORY_KEYS = [
  "search-web", "registry-generic", "biz-directory", "launch-platform",
  "agency-directory", "dev-ecosystem", "hiring-platform", "company-site",
  "linkedin", "x-platform", "instagram", "facebook",
];

const PROBE_KEY = "r02-probe-connector";

interface Counts {
  categories: number;
  connectors: number;
  total: number;
}

async function counts(client: Pool | PoolClient): Promise<Counts> {
  const r = await client.query<{ categories: string; connectors: string; total: string }>(
    `select count(*) filter (where kind = 'category') as categories,
            count(*) filter (where kind = 'connector') as connectors,
            count(*) as total
     from public.source`,
  );
  return {
    categories: Number(r.rows[0].categories),
    connectors: Number(r.rows[0].connectors),
    total: Number(r.rows[0].total),
  };
}

afterAll(async () => {
  // Belt and braces: never leave a probe row behind, whatever happened above.
  await pool.query("delete from public.source where key = $1", [PROBE_KEY]);
  await pool.end();
});

describe("source registry: category invariant (R-02)", () => {
  it("holds exactly 12 category rows covering every approved S-code", async () => {
    const before = await counts(pool);
    expect(before.categories, "exactly 12 category rows").toBe(12);

    const rows = await pool.query<{ key: string; category: string }>(
      "select key, category from public.source where kind = 'category' order by key",
    );
    expect(rows.rows.map((r) => r.key).sort()).toEqual([...CATEGORY_KEYS].sort());

    const codes = [...new Set(rows.rows.map((r) => r.category))].sort();
    expect(codes).toEqual(APPROVED_CODES);
  });

  it("keeps the T-006 GLEIF connector registered, enabled, and correctly typed", async () => {
    const r = await pool.query(
      "select key, kind, category, enabled, reliability_prior from public.source where key = 'gleif-api'",
    );
    expect(r.rows, "gleif-api must not be deleted by the category-count correction").toHaveLength(1);
    expect(r.rows[0].kind).toBe("connector");
    expect(r.rows[0].category).toBe("S-02");
    expect(r.rows[0].enabled).toBe(true);
    expect(r.rows[0].reliability_prior).toBe("A");

    const c = await counts(pool);
    expect(c.connectors).toBeGreaterThanOrEqual(1);
    expect(c.total, "connectors are additional source rows, not hidden ones").toBe(c.categories + c.connectors);
  });

  it("adding a connector does not change the category count", async () => {
    const before = await counts(pool);
    const client = await pool.connect();
    try {
      // Rollback guarantees the registry is left exactly as found.
      await client.query("begin");
      const r = await client.query(
        `insert into public.source (key, category, platform, reliability_prior, enabled, kind)
         values ($1, 'S-05', 'R-02 probe connector', 'C', false, 'connector')
         on conflict (key) do nothing
         returning key`,
        [PROBE_KEY],
      );
      expect(r.rows).toHaveLength(1);

      const during = await counts(client);
      expect(during.categories, "category count must be untouched").toBe(before.categories);
      expect(during.connectors).toBe(before.connectors + 1);
      expect(during.total).toBe(before.total + 1);

      const visible = await client.query("select 1 from public.source where key = $1 and kind = 'connector'", [
        PROBE_KEY,
      ]);
      expect(visible.rows).toHaveLength(1);

      await client.query("rollback");
    } finally {
      client.release();
    }
    const after = await counts(pool);
    expect(after.categories).toBe(before.categories);
    expect(after.connectors).toBe(before.connectors);
    expect(after.total).toBe(before.total);
  });

  it("rejects a connector hanging off an unapproved source code", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      // Reddit/YouTube remain unrepresentable: no category value exists.
      await expect(
        client.query(
          `insert into public.source (key, category, platform, reliability_prior, kind)
           values ('r02-reddit-probe', 'S-13', 'reddit', 'D', 'connector')`,
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await client.query("rollback");
    } finally {
      client.release();
    }
    const left = await pool.query("select count(*)::int as n from public.source where key like 'r02-%'");
    expect(left.rows[0].n, "no probe rows may survive").toBe(0);
  });

  it("leaves no probe residue behind", async () => {
    const r = await pool.query("select count(*)::int as n from public.source where key = $1", [PROBE_KEY]);
    expect(r.rows[0].n).toBe(0);
  });
});