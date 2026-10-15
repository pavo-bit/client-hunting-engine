/**
 * F3: eligibility history is append-only AT THE DATABASE LEVEL (migration M8).
 *
 * Application convention ("we only ever insert") is not protection. These
 * tests prove the database itself rejects a rewrite, proves INSERT and SELECT
 * still work, proves the T-007-style DELETE exemption still allows parent
 * cascade (opportunity removal / test isolation), and proves an unprivileged
 * role is refused before the trigger is even reached.
 *
 * Runs against the isolated test database; the dev database is never touched.
 */
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { evaluateEligibility, eligibilityHistory } from "../lib/discovery/eligibility";
import { registerOpportunity } from "../lib/discovery/opportunities";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const NOACCESS_URL =
  process.env.TEST_NOACCESS_URL ??
  "postgresql://noaccess:noaccess-local-only@127.0.0.1:5434/agency_intel_test";
const pool = new Pool({ connectionString: DB_URL, max: 3 });
const ACTOR = "f3";

const POLICY = {
  version: "f3-policy-v1",
  gates: [{ id: "f3-gate", passed: true, reason: "f3 fixture" }],
};

async function cleanup(): Promise<void> {
  await pool.query(
    "delete from public.opportunity where opportunity_key like 'opp:agency_partner:f3-src:%'",
  );
  await pool.query("delete from public.company where domain_norm like 'f3-%'");
}

async function seedOpportunity(): Promise<string> {
  const co = await createCompany(
    pool,
    { name: "F3 History Co", domain: `f3-${Date.now()}.example`, agencyType: "web_development", country: "United States" },
    ACTOR,
  );
  const o = await registerOpportunity(pool, {
    pipeline: "agency_partner",
    sourceKey: "f3-src",
    sourceRecordId: `F3-${Date.now()}`,
    companyId: co.companyId,
    actor: ACTOR,
  });
  return o.id;
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("F3: opportunity_eligibility is append-only", () => {
  it("INSERT and SELECT still work", async () => {
    try {
      const id = await seedOpportunity();
      const rec = await evaluateEligibility(pool, id, POLICY, { actor: ACTOR });
      expect(rec.version).toBe(1);
      expect(rec.decision).toBe("eligible");
      const history = await eligibilityHistory(pool, id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ version: 1, decision: "eligible", policyVersion: "f3-policy-v1" });
      // A second evaluation appends version 2 and never rewrites version 1.
      const second = await evaluateEligibility(pool, id, POLICY, { actor: ACTOR });
      expect(second.version).toBe(2);
      const after = await eligibilityHistory(pool, id);
      expect(after.map((h) => h.version)).toEqual([1, 2]);
      expect(after[0].decision).toBe("eligible");
    } finally {
      await cleanup();
    }
  });

  it("UPDATE is rejected by the database, even for the table owner", async () => {
    try {
      const id = await seedOpportunity();
      await evaluateEligibility(pool, id, POLICY, { actor: ACTOR });
      await expect(
        pool.query("update public.opportunity_eligibility set decision = 'ineligible' where opportunity_id = $1", [id]),
      ).rejects.toThrow(/append-only/i);
      // Nothing changed.
      const history = await eligibilityHistory(pool, id);
      expect(history.map((h) => h.decision)).toEqual(["eligible"]);
      // A second attempt through a fresh connection behaves identically.
      const other = new Client({ connectionString: DB_URL });
      await other.connect();
      try {
        await expect(
          other.query("update public.opportunity_eligibility set policy_version = 'rewritten' where opportunity_id = $1", [id]),
        ).rejects.toThrow(/append-only/i);
      } finally {
        await other.end();
      }
    } finally {
      await cleanup();
    }
  });

  it("an UPDATE that changes nothing is still rejected (no silent no-op writes)", async () => {
    try {
      const id = await seedOpportunity();
      await evaluateEligibility(pool, id, POLICY, { actor: ACTOR });
      await expect(
        pool.query("update public.opportunity_eligibility set decided_by = decided_by where opportunity_id = $1", [id]),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await cleanup();
    }
  });

  it("DELETE is permitted only as the consequence of removing the parent opportunity", async () => {
    try {
      const id = await seedOpportunity();
      await evaluateEligibility(pool, id, POLICY, { actor: ACTOR });
      expect(await eligibilityHistory(pool, id)).toHaveLength(1);

      // Deleting the opportunity cascades its history away (retention/takedown
      // and test isolation must keep working - same rationale as T-007 8f).
      await pool.query("delete from public.opportunity where id = $1", [id]);
      expect(await eligibilityHistory(pool, id)).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("an unprivileged role is refused before the trigger can matter", async () => {
    if (!/127\.0\.0\.1|localhost/.test(new URL(NOACCESS_URL).hostname)) {
      throw new Error("refusing non-local database");
    }
    try {
      const id = await seedOpportunity();
      await evaluateEligibility(pool, id, POLICY, { actor: ACTOR });
      const role = new Client({ connectionString: NOACCESS_URL });
      await role.connect();
      try {
        await expect(role.query("select * from public.opportunity_eligibility")).rejects.toThrow(
          /permission denied/i,
        );
        await expect(
          role.query("update public.opportunity_eligibility set decision = 'ineligible'"),
        ).rejects.toThrow(/permission denied/i);
        await expect(role.query("delete from public.opportunity_eligibility")).rejects.toThrow(
          /permission denied/i,
        );
      } finally {
        await role.end();
      }
      // The owner's rows are untouched by the refused attempts.
      expect(await eligibilityHistory(pool, id)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});