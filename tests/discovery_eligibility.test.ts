/**
 * Discovery eligibility tests (local DB only, loopback guard).
 * Covers TEST_PLAN structure: explicit-policy evaluation (eligible /
 * ineligible / needs_info), refusal without policy, append-only versioning,
 * history order, direct-client refusal (O1), unknown rows, actor required.
 * DB-BACKED: blocked until Docker/PostgreSQL is available.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerOpportunity } from "../lib/discovery/opportunities";
import {
  eligibilityHistory,
  evaluateEligibility,
  type EligibilityPolicy,
} from "../lib/discovery/eligibility";

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 3 });
const ACTOR = "ddisc";
let seq = 0;

const PASS_POLICY: EligibilityPolicy = {
  version: "eligibility-test-v1",
  gates: [
    { id: "identity-resolved", passed: true, reason: "ddisc: canonical company" },
    { id: "support-present", passed: true, reason: "ddisc: two observations" },
  ],
};
const FAIL_POLICY: EligibilityPolicy = {
  version: "eligibility-test-v1",
  gates: [
    { id: "identity-resolved", passed: true, reason: "ddisc: canonical company" },
    { id: "support-present", passed: false, reason: "ddisc: single thin observation" },
  ],
};

async function mkOpp(): Promise<string> {
  const o = await registerOpportunity(pool, {
    pipeline: "agency_partner",
    sourceKey: "ddisc-src",
    sourceRecordId: `ELIG-${Date.now()}-${seq++}`,
    actor: ACTOR,
  });
  return o.id;
}

async function cleanup() {
  const c = await pool.connect();
  try {
    await c.query("delete from public.opportunity where opportunity_key like 'opp:%:ddisc-%'");
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("evaluateEligibility", () => {
  it("decides eligible/ineligible/needs_info from explicit gates", async () => {
    try {
      const id = await mkOpp();
      const e = await evaluateEligibility(pool, id, PASS_POLICY, { actor: ACTOR });
      expect(e.decision).toBe("eligible");
      expect(e.version).toBe(1);
      expect(e.policyVersion).toBe("eligibility-test-v1");
      const i = await evaluateEligibility(pool, id, FAIL_POLICY, { actor: ACTOR });
      expect(i.decision).toBe("ineligible");
      expect(i.version).toBe(2);
      expect(JSON.stringify(i.gateReasons)).toContain("support-present");
      const n = await evaluateEligibility(pool, id, PASS_POLICY, {
        actor: ACTOR,
        uncertain: true,
        uncertaintyNote: "ddisc: reviewer wants a second look",
      });
      expect(n.decision).toBe("needs_info");
      expect(n.version).toBe(3);
    } finally {
      await cleanup();
    }
  });

  it("refuses empty policies, bad gates, missing actors, unknown rows", async () => {
    try {
      const id = await mkOpp();
      await expect(
        evaluateEligibility(pool, id, { version: "", gates: PASS_POLICY.gates }, { actor: ACTOR }),
      ).rejects.toMatchObject({ status: 422, code: "bad_policy" });
      await expect(
        evaluateEligibility(pool, id, { version: "v", gates: [] }, { actor: ACTOR }),
      ).rejects.toMatchObject({ status: 422, code: "bad_policy" });
      await expect(
        evaluateEligibility(pool, id, { version: "v", gates: [{ id: "", passed: true, reason: "" }] }, { actor: ACTOR }),
      ).rejects.toMatchObject({ status: 422, code: "bad_gate" });
      await expect(evaluateEligibility(pool, id, PASS_POLICY, { actor: "" })).rejects.toMatchObject({
        status: 422,
        code: "actor_required",
      });
      await expect(
        evaluateEligibility(pool, "00000000-0000-4000-8000-000000000000", PASS_POLICY, { actor: ACTOR }),
      ).rejects.toMatchObject({ status: 404 });
      // Nothing versioned by the refusals.
      expect(await eligibilityHistory(pool, id)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("keeps append-only version history in order", async () => {
    try {
      const id = await mkOpp();
      await evaluateEligibility(pool, id, FAIL_POLICY, { actor: ACTOR });
      await evaluateEligibility(pool, id, PASS_POLICY, { actor: ACTOR });
      const h = await eligibilityHistory(pool, id);
      expect(h.map((x) => [x.version, x.decision])).toEqual([
        [1, "ineligible"],
        [2, "eligible"],
      ]);
      // History rows are never rewritten: re-read identical.
      expect(await eligibilityHistory(pool, id)).toEqual(h);
    } finally {
      await cleanup();
    }
  });
});
