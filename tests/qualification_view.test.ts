/**
 * Part 1 §6: the frozen qualification view contract.
 *
 * `v_opportunity_for_qualification_v1` is the single interface Phase 2 reads.
 * These tests pin what "frozen" means: the exact column set (any added,
 * removed or reordered column fails), the nullability contract the migration
 * promises, the honesty rules (no eligibility content until O10, suppression
 * derived from existing state only), and the permission boundary (the Phase 2
 * role reads the approved columns but never operator attribution; the
 * unprivileged role reads nothing).
 *
 * Runs against the isolated test database; the dev database is never touched.
 */
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTestDatabases } from "./helpers/test-db";
import { createCompany } from "../lib/intake/import";
import { evaluateEligibility } from "../lib/discovery/eligibility";
import { registerOpportunity, transitionOpportunity } from "../lib/discovery/opportunities";
import {
  QUALIFICATION_COLUMNS,
  listQualificationRows,
  readQualificationRow,
  stateHashOf,
  type QualificationRow,
} from "../lib/qualification/view";

const DBS = resolveTestDatabases(process.env, {
  test: "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test",
});
const DB_URL = DBS.testDatabaseUrl;
const P2_URL = DBS.p2Url;
const NOACCESS_URL = DBS.noAccessUrl;
const pool = new Pool({ connectionString: DB_URL, max: 4 });
const ACTOR = "p1v";
const POLICY = { version: "p1v-policy-v1", gates: [{ id: "g", passed: true, reason: "p1v" }] };

async function cleanup(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("delete from p2.case where discovery_opportunity_key like '%p1v-%'");
    // Opportunities before companies: `company` is RESTRICT-referenced.
    // Keys carry the source segment (`opp:agency_partner:agency-directory:p1v-…`),
    // so the pattern matches the namespaced record id, not a key prefix.
    await c.query(
      "delete from public.opportunity where opportunity_key like '%p1v-%'",
    );
    // Unmerge before deleting: merged test companies RESTRICT-reference their
    // canonical row.
    await c.query(
      "update public.company set merged_into = null where domain_norm like 'p1v-%' and merged_into is not null",
    );
    await c.query("delete from public.company where domain_norm like 'p1v-%'");
  } finally {
    c.release();
  }
}

async function seedOpportunity(tag: string): Promise<{ companyId: string; opportunityId: string; key: string }> {
  const co = await createCompany(
    pool,
    {
      name: `P1v ${tag} Co`,
      domain: `p1v-${tag}-${Date.now()}.example`,
      agencyType: "web_development",
      country: "United States",
    },
    ACTOR,
  );
  const o = await registerOpportunity(pool, {
    pipeline: "agency_partner",
    sourceKey: "agency-directory",
    sourceRecordId: `P1V-${tag}-${Date.now()}`,
    companyId: co.companyId,
    actor: ACTOR,
  });
  return { companyId: co.companyId, opportunityId: o.id, key: o.key };
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("P1-6: the view exposes exactly the frozen column set", () => {
  it("column names and order match the contract", async () => {
    const r = await pool.query(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'v_opportunity_for_qualification_v1'
       order by ordinal_position`,
    );
    expect(r.rows.map((x: { column_name: string }) => x.column_name)).toEqual([...QUALIFICATION_COLUMNS]);
  });

  it("refuses unknown view names instead of guessing (contract safety)", async () => {
    // The reader hardcodes the v1 name; there is no parameter for it.
    await expect(
      pool.query("select * from public.v_opportunity_for_qualification_v2 limit 1"),
    ).rejects.toThrow(/does not exist/i);
  });
});

describe("P1-6: honest content rules", () => {
  it("shows identity + zero evidence with NULL eligibility until O10", async () => {
    try {
      const s = await seedOpportunity("honest");
      const row = (await readQualificationRow(pool, s.opportunityId)) as QualificationRow;
      expect(row.opportunity_key).toBe(s.key);
      expect(row.pipeline).toBe("agency_partner");
      expect(row.opportunity_status).toBe("observed");
      expect(row.company_name).toContain("P1v honest Co");
      expect(row.suppression_reason).toBeNull();
      // No eligibility content exists (O10 OPEN): NULL, not a fabricated row.
      expect(row.eligibility_version).toBeNull();
      expect(row.eligibility_decision).toBeNull();
      expect(row.eligibility_policy_version).toBeNull();
      expect(row.evidence_claims_total).toBe(0);
      // One discovery record exists (the manual creation itself) with an
      // unknown source — truthful provenance, not zero records and not a
      // fabricated source name.
      expect(row.provenance_sources_total).toBe(1);
      expect(row.provenance_source_keys).toEqual([null]);
      expect(row.last_event_sequence).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("reflects the latest eligibility decision and stamps the rule version", async () => {
    try {
      const s = await seedOpportunity("elig");
      await transitionOpportunity(pool, s.opportunityId, "eligible", { actor: ACTOR, reason: "p1v" });
      await evaluateEligibility(pool, s.opportunityId, POLICY, { actor: ACTOR });
      const row = (await readQualificationRow(pool, s.opportunityId)) as QualificationRow;
      expect(row.opportunity_status).toBe("eligible");
      expect(row.eligibility_version).toBe(1);
      expect(row.eligibility_decision).toBe("eligible");
      expect(row.eligibility_policy_version).toBe("p1v-policy-v1");
      expect(row.rule_version).toBe("p1v-policy-v1");
      expect(row.last_event_sequence).toBe(3);
    } finally {
      await cleanup();
    }
  });

  it("derives suppression from existing state only (archived, merged)", async () => {
    try {
      const s = await seedOpportunity("supp");
      await transitionOpportunity(pool, s.opportunityId, "archived", { actor: ACTOR, reason: "p1v" });
      const archived = (await readQualificationRow(pool, s.opportunityId)) as QualificationRow;
      expect(archived.suppression_reason).toBe("opportunity_archived");

      // A company merged into a canonical record suppresses its opportunities.
      // The schema requires discovery_status='archived' alongside merged_into
      // (company_merge_state CHECK) — mirrors what a real merge records.
      const canon = await createCompany(
        pool,
        { name: "P1v Canonical Co", domain: `p1v-canon-${Date.now()}.example`, agencyType: "web_development", country: "United States" },
        ACTOR,
      );
      await pool.query(
        "update public.company set merged_into = $1, discovery_status = 'archived' where id = $2",
        [canon.companyId, s.companyId],
      );
      const merged = (await readQualificationRow(pool, s.opportunityId)) as QualificationRow;
      expect(merged.suppression_reason).toBe("company_merged");
    } finally {
      await cleanup();
    }
  });

  it("state hash moves exactly when Discovery truth moves", async () => {
    try {
      const s = await seedOpportunity("hash");
      const before = stateHashOf((await readQualificationRow(pool, s.opportunityId)) as QualificationRow);
      await transitionOpportunity(pool, s.opportunityId, "eligible", { actor: ACTOR, reason: "p1v" });
      const after = stateHashOf((await readQualificationRow(pool, s.opportunityId)) as QualificationRow);
      expect(after).not.toBe(before);
      // Same input bytes hash identically in any process (determinism).
      const again = stateHashOf((await readQualificationRow(pool, s.opportunityId)) as QualificationRow);
      expect(again).toBe(after);
    } finally {
      await cleanup();
    }
  });

  it("lists with totals, paging and suppression filtering", async () => {
    try {
      await seedOpportunity("lista");
      await seedOpportunity("listb");
      const all = await listQualificationRows(pool, { pipeline: "agency_partner", limit: 1, offset: 0 });
      expect(all.total).toBeGreaterThanOrEqual(2);
      expect(all.rows).toHaveLength(1);
      const second = await listQualificationRows(pool, { pipeline: "agency_partner", limit: 1, offset: 1 });
      expect(second.rows).toHaveLength(1);
      expect(second.rows[0].opportunity_id).not.toBe(all.rows[0].opportunity_id);
      await expect(
        listQualificationRows(pool, { pipeline: "inventory" as never }),
      ).rejects.toMatchObject({ status: 422, code: "bad_pipeline" });
    } finally {
      await cleanup();
    }
  });
});

describe("P1-6: permission boundary on the view", () => {
  it("the Phase 2 role reads approved columns but never operator attribution", async () => {
    const p2 = new Client({ connectionString: P2_URL });
    await p2.connect();
    try {
      const ok = await p2.query(
        "select opportunity_id, pipeline, opportunity_status from public.v_opportunity_for_qualification_v1 limit 1",
      );
      expect(Array.isArray(ok.rows)).toBe(true);
      await expect(
        p2.query("select last_transition_actor from public.v_opportunity_for_qualification_v1 limit 1"),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await p2.end();
    }
  });

  it("the unprivileged role reads nothing", async () => {
    const na = new Client({ connectionString: NOACCESS_URL });
    await na.connect();
    try {
      await expect(
        na.query("select * from public.v_opportunity_for_qualification_v1 limit 1"),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await na.end();
    }
  });
});
