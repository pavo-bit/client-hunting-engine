/**
 * F13: source provenance is never invented.
 *
 * Root cause under test: when a new discovery item could not be matched to its
 * stored `discovery_record`, the refresh loop fell back to the literal string
 * "unknown-source" and registered the opportunity anyway. The source key is
 * part of `opportunity_key` — the row's permanent unique identity — so that
 * fallback fabricated provenance that could never be corrected without a
 * migration, and could collide across unrelated sources sharing a record id.
 *
 * These tests pin the fail-closed behaviour instead: resolve from the stored
 * record, or report and write nothing.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { createRegistry } from "../lib/discovery/registry";
import { AgencyDirectoryFixture } from "../lib/discovery/fixtures/agency-directory";
import { attributeNewItem, runRefresh } from "../lib/discovery/refresh";
import type { RunItemResult } from "../lib/discovery/run";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 4 });
const ACTOR = "f13";

function item(over: Partial<RunItemResult> = {}): RunItemResult {
  return {
    sourceRecordId: "F13-X",
    status: "new",
    companyId: null,
    candidateId: null,
    warnings: [],
    note: null,
    ...over,
  };
}

async function cleanup(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(
      "delete from public.opportunity where opportunity_key like 'opp:agency_partner:f13-%' or opportunity_key like 'opp:agency_partner:agency-directory:%'",
    );
    await c.query("delete from public.discovery_run where created_by = $1", [ACTOR]);
    await c.query("delete from public.company where domain_norm like 'f13-%' or domain_norm like 'fixture-%'");
  } finally {
    c.release();
  }
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("F13: a resolvable source record yields a correctly attributed opportunity", () => {
  it("registers the opportunity under the STORED source key", async () => {
    try {
      const stamp = Date.now();
      const co = await createCompany(
        pool,
        {
          name: "F13 Attributed Co",
          domain: `f13-ok-${stamp}.example`,
          agencyType: "web_development",
          country: "United States",
        },
        ACTOR,
        { sourceKey: "agency-directory", sourceRecordId: `F13-OK-${stamp}`, collectionMethod: "api", note: "f13 provenance probe", auditReason: "f13 provenance probe" },
      );
      const r = await pool.connect();
      let parentId = "";
      try {
        const p = await r.query(
          `insert into public.discovery_run (adapter_id, adapter_version, status, query_text, created_by)
           values ('f13-manual', '1', 'running', 'f13 parent', $1) returning id`,
          [ACTOR],
        );
        parentId = p.rows[0].id as string;
      } finally {
        r.release();
      }
      const outcome = await attributeNewItem(
        pool,
        item({ companyId: co.companyId, sourceRecordId: `F13-OK-${stamp}` }),
        parentId,
        ACTOR,
      );
      expect(outcome).toBe("registered");
      const row = await pool.query(
        "select opportunity_key from public.opportunity where company_id = $1",
        [co.companyId],
      );
      // The key carries the real source, never a placeholder.
      expect(row.rows[0].opportunity_key).toBe(
        `opp:agency_partner:agency-directory:f13-ok-${stamp}`,
      );
    } finally {
      await cleanup();
    }
  });
});

describe("F13: an unresolvable source is reported, never mislabeled", () => {
  it("writes nothing and returns 'unattributed' when the discovery record is missing", async () => {
    try {
      const stamp = Date.now();
      const co = await createCompany(
        pool,
        {
          name: "F13 Orphan Co",
          domain: `f13-orphan-${stamp}.example`,
          agencyType: "web_development",
          country: "United States",
        },
        ACTOR,
        // Company exists; deliberately NO discovery_record row for this id.
      );
      const parent = await pool.query(
        `insert into public.discovery_run (adapter_id, adapter_version, status, query_text, created_by)
         values ('f13-manual', '1', 'running', 'f13 parent orphan', $1) returning id`,
        [ACTOR],
      );
      const outcome = await attributeNewItem(
        pool,
        item({ companyId: co.companyId, sourceRecordId: `F13-MISSING-${stamp}` }),
        parent.rows[0].id as string,
        ACTOR,
      );
      expect(outcome).toBe("unattributed");
      // Nothing was created - in particular nothing keyed 'unknown-source'.
      const rows = await pool.query(
        "select opportunity_key from public.opportunity where company_id = $1",
        [co.companyId],
      );
      expect(rows.rows).toHaveLength(0);
      const placeholder = await pool.query(
        "select count(*)::int as n from public.opportunity where opportunity_key like '%unknown-source%'",
      );
      expect(placeholder.rows[0].n).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("a discovery_record with a NULL source_key is also unattributable", async () => {
    try {
      const stamp = Date.now();
      const co = await createCompany(
        pool,
        {
          name: "F13 Null Source Co",
          domain: `f13-null-${stamp}.example`,
          agencyType: "web_development",
          country: "United States",
        },
        ACTOR,
        { sourceKey: "company-site", sourceRecordId: `F13-NULL-${stamp}`, collectionMethod: "api", note: "f13 null-source probe", auditReason: "f13 null-source probe" },
      );
      // Simulate a record whose provenance was never filled in.
      await pool.query(
        "update public.discovery_record set source_key = null where source_record_id = $1",
        [`F13-NULL-${stamp}`],
      );
      const parent = await pool.query(
        `insert into public.discovery_run (adapter_id, adapter_version, status, query_text, created_by)
         values ('f13-manual', '1', 'running', 'f13 parent null', $1) returning id`,
        [ACTOR],
      );
      const outcome = await attributeNewItem(
        pool,
        item({ companyId: co.companyId, sourceRecordId: `F13-NULL-${stamp}` }),
        parent.rows[0].id as string,
        ACTOR,
      );
      expect(outcome).toBe("unattributed");
      const rows = await pool.query(
        "select count(*)::int as n from public.opportunity where company_id = $1",
        [co.companyId],
      );
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("non-new or unidentifiable items are skipped without consulting provenance", async () => {
    expect(await attributeNewItem(pool, item({ status: "duplicate" }), "00000000-0000-4000-8000-000000000000", ACTOR)).toBe(
      "skipped",
    );
    expect(await attributeNewItem(pool, item({ companyId: null }), "00000000-0000-4000-8000-000000000000", ACTOR)).toBe(
      "skipped",
    );
    expect(
      await attributeNewItem(pool, item({ sourceRecordId: "" }), "00000000-0000-4000-8000-000000000000", ACTOR),
    ).toBe("skipped");
  });
});

describe("F13: the refresh result surfaces the unattributed count", () => {
  it("an ordinary refresh reports zero and creates no placeholder keys", async () => {
    try {
      const r = await runRefresh(pool, createRegistry([new AgencyDirectoryFixture()]), {
        tasks: [{ adapterId: "agency-directory-fixture", queryText: "f13-ok", limit: 3, maxPages: 1 }],
        actor: ACTOR,
      });
      expect(r.status).toBe("ok");
      expect(r.unattributedSourceRecords).toBe(0);
      const keys = await pool.query(
        "select opportunity_key from public.opportunity where run_id = $1",
        [r.runId],
      );
      expect(keys.rows.length).toBeGreaterThan(0);
      for (const k of keys.rows as { opportunity_key: string }[]) {
        expect(k.opportunity_key).not.toContain("unknown-source");
        // Real provenance: the fixture's declared source key is in the key.
        expect(k.opportunity_key.startsWith("opp:agency_partner:agency-directory:")).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });
});