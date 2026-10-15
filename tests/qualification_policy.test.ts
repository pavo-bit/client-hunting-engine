/**
 * Part 2 §4/§7: versioned policy, catalog, rubric and capacity machinery.
 *
 * What is proven here: structural validation (lint) rejects malformed
 * definitions with named problems; draft storage never activates (a draft is
 * invisible to every read path); publication is explicit and audited;
 * blocked services can never appear as approved; approving nothing is the
 * default state. What is NOT here: any approved production content — the
 * O10/D-004/D-006/O7 decisions stay OPEN, so every version in this file lives
 * and dies in the test database.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvedServices,
  draftCapacity,
  draftPolicy,
  draftRubric,
  draftService,
  dryRunPolicy,
  lintCapacity,
  lintPolicy,
  lintRubric,
  lintService,
  publishCapacity,
  publishCatalog,
  publishPolicy,
  publishRubric,
  readPolicy,
} from "../lib/qualification/policy";
import { activePolicyVersion } from "../lib/qualification/policy";
import { setReferenceStatus } from "../lib/qualification/cases";
import {
  ACTOR,
  cleanupFixtures,
  fixtureCapacity,
  fixturePolicy,
  fixtureRubric,
  fixtureService,
  registerFixtureSet,
} from "./qualification_fixtures";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 4 });

beforeAll(cleanupFixtures.bind(null, pool));
afterAll(async () => {
  await cleanupFixtures(pool);
  await pool.end();
});

describe("P2-policy: lint rejects malformed definitions with named problems", () => {
  it("accepts the well-formed fixture policy", () => {
    expect(lintPolicy(fixturePolicy())).toEqual({ ok: true });
  });

  it("rejects unknown/duplicate gates, bad weights, unordered bands", () => {
    const badGates = fixturePolicy({ gates: [{ id: "suppression", outcomeOnFail: "blocked" }] as never });
    (badGates.gates as unknown[]).push({ id: "suppression", outcomeOnFail: "blocked" });
    const r1 = lintPolicy(badGates);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.problems.join(" ")).toMatch(/duplicated/);

    const badWeights = fixturePolicy({ weights: { service_fit: -1 } as never });
    const r2 = lintPolicy(badWeights);
    expect(r2.ok).toBe(false);

    const pursuitWeighted = fixturePolicy({
      weights: { service_fit: 0.2, need_strength: 0.2, timing: 0.2, evidence_confidence: 0.2, actionability: 0.1, pursuit_priority: 0.1 } as never,
    });
    const r3 = lintPolicy(pursuitWeighted);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.problems.join(" ")).toMatch(/never weighted/);

    const badBands = fixturePolicy({ bands: [{ name: "A", min: 10 }, { name: "B", min: 90 }] });
    expect(lintPolicy(badBands).ok).toBe(false);

    const zeroWeights = fixturePolicy({
      weights: { service_fit: 0, need_strength: 0, timing: 0, evidence_confidence: 0, actionability: 0 },
    });
    expect(lintPolicy(zeroWeights).ok).toBe(false);
  });

  it("rejects services missing required §4 fields", () => {
    expect(lintService(fixtureService()).ok).toBe(true);
    const noSignals = fixtureService({ signalFamilies: [] });
    expect(lintService(noSignals).ok).toBe(false);
    const badStatus = fixtureService({ status: "blessed" as never });
    expect(lintService(badStatus).ok).toBe(false);
    const badPipeline = fixtureService({ pipelines: ["carrier-pigeon"] as never });
    expect(lintService(badPipeline).ok).toBe(false);
  });

  it("rejects incomplete rubrics and capacities", () => {
    expect(lintRubric(fixtureRubric()).ok).toBe(true);
    const missing = fixtureRubric();
    delete (missing as Record<string, unknown>).timing;
    expect(lintRubric(missing).ok).toBe(false);
    expect(lintCapacity(fixtureCapacity()).ok).toBe(true);
    expect(lintCapacity({ ...fixtureCapacity(), maxActivePursuits: 0 }).ok).toBe(false);
  });

  it("dry-run validates without storing anything", async () => {
    const v = `p2t-dry-${Date.now()}`;
    expect(dryRunPolicy(fixturePolicy())).toEqual({ ok: true });
    expect(dryRunPolicy({ gates: [] }).ok).toBe(false);
    const stored = await pool.query("select 1 from p2.scoring_policy where policy_version = $1", [v]);
    expect(stored.rows).toEqual([]);
  });
});

describe("P2-policy: draft never activates; publication is explicit", () => {
  it("a stored draft is invisible until published, then readable", async () => {
    const v = `p2t-draft-${Date.now()}`;
    try {
      await draftPolicy(pool, v, fixturePolicy(), ACTOR);
      // Draft exists but is not the active policy.
      const ref = await pool.query("select status from p2.reference_version where kind = 'policy' and version = $1", [v]);
      expect(ref.rows[0].status).toBe("draft");
      // Publication is a separate, audited act.
      await publishPolicy(pool, v, ACTOR);
      expect((await pool.query("select status from p2.reference_version where kind = 'policy' and version = $1", [v])).rows[0].status).toBe("active");
      expect((await readPolicy(pool, v)).minCoverage).toBe(0.5);
      // Publishing twice is refused (draft -> active only).
      await expect(publishPolicy(pool, v, ACTOR)).rejects.toMatchObject({ code: "bad_reference_transition" });
    } finally {
      await pool.query("delete from p2.scoring_policy where policy_version = $1", [v]);
      await pool.query("delete from p2.reference_version where kind = 'policy' and version = $1", [v]);
    }
  });

  it("publishing an unknown version is a 404, not a silent no-op", async () => {
    await expect(publishPolicy(pool, "p2t-ghost", ACTOR)).rejects.toMatchObject({ status: 404 });
    await expect(publishCatalog(pool, "p2t-ghost", ACTOR)).rejects.toMatchObject({ status: 404 });
    await expect(publishRubric(pool, "p2t-ghost", ACTOR)).rejects.toMatchObject({ status: 404 });
    await expect(publishCapacity(pool, "p2t-ghost", ACTOR)).rejects.toMatchObject({ status: 404 });
  });

  it("blocked services are stored but never listed as approved", async () => {
    const cat = `p2t-blocked-${Date.now()}`;
    try {
      await draftService(pool, cat, fixtureService({ serviceId: "ok-svc" }), ACTOR);
      await draftService(pool, cat, fixtureService({ serviceId: "blocked-svc", status: "blocked" }), ACTOR);
      // Not active yet: nothing exposed.
      await expect(approvedServices(pool, cat)).rejects.toMatchObject({ code: "catalog_not_active" });
      await publishCatalog(pool, cat, ACTOR);
      const approved = await approvedServices(pool, cat);
      expect(approved.map((s) => s.serviceId)).toEqual(["ok-svc"]);
    } finally {
      await pool.query("delete from p2.service_catalog where catalog_version = $1", [cat]);
      await pool.query("delete from p2.reference_version where kind = 'service_catalog' and version = $1", [cat]);
    }
  });

  it("retiring a version is explicit and recorded", async () => {
    const v = `p2t-ret-${Date.now()}`;
    try {
      await draftCapacity(pool, v, fixtureCapacity(), ACTOR);
      await publishCapacity(pool, v, ACTOR);
      await setReferenceStatus(pool, "capacity", v, "retired", ACTOR);
      const ref = await pool.query("select status from p2.reference_version where kind = 'capacity' and version = $1", [v]);
      expect(ref.rows[0].status).toBe("retired");
    } finally {
      await pool.query("delete from p2.capacity_profile where capacity_version = $1", [v]);
      await pool.query("delete from p2.reference_version where kind = 'capacity' and version = $1", [v]);
    }
  });
});

describe("P2-policy: active-version resolution is latest-wins (procedural gate documented)", () => {
  it("two active versions resolve to the latest; activation must verify singularity", async () => {
    // Verified behavior (not a fix): nothing in the schema prevents two
    // active versions of one kind; readers take latest by recorded_at. The
    // activation package therefore requires a procedural check — exactly one
    // active version per kind — instead of assuming the database enforces it.
    const v1 = `p2t-multi-a-${Date.now()}`;
    const v2 = `p2t-multi-b-${Date.now()}`;
    try {
      await draftPolicy(pool, v1, fixturePolicy(), ACTOR);
      await draftPolicy(pool, v2, fixturePolicy(), ACTOR);
      await publishPolicy(pool, v1, ACTOR);
      await new Promise((r) => setTimeout(r, 20));
      await publishPolicy(pool, v2, ACTOR);
      expect(await activePolicyVersion(pool)).toBe(v2);
      const both = await pool.query(
        "select count(*)::int as n from p2.reference_version where kind = 'policy' and version in ($1, $2) and status = 'active'",
        [v1, v2],
      );
      // Both active simultaneously: legal today, gated procedurally at activation.
      expect(both.rows[0].n).toBe(2);
    } finally {
      await pool.query("delete from p2.scoring_policy where policy_version = any($1)", [[v1, v2]]);
      await pool.query("delete from p2.reference_version where kind = 'policy' and version = any($1)", [[v1, v2]]);
    }
  });
});

describe("P2-policy: no approved production content exists", () => {
  it("the dev-owned contract holds here too: fixture set registers cleanly", async () => {
    // This test documents the boundary, not production state: the fixture set
    // helper publishes versions in the TEST database only.
    const set = await registerFixtureSet(pool, "pol");
    try {
      expect(await activePolicyVersion(pool)).not.toBeNull();
      const approved = await approvedServices(pool, set.catalogVersion);
      expect(approved.map((s) => s.serviceId)).toContain("portal-build");
    } finally {
      await cleanupFixtures(pool);
    }
  });
});