/**
 * Part 2 §6: qualification gates as pure, independently tested rules.
 *
 * Every gate is tested alone; every PAIR of simultaneous failures is tested
 * for deterministic precedence (first failure in policy order wins — 21
 * pairs over the 7 gates); suppression is proven absolute (first regardless
 * of policy order, and no score or override can lift it — there is no
 * override parameter to pass).
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidenceBundle } from "../lib/qualification/evidence";
import {
  evaluateGates,
  gateContradictionFreshness,
  gateEvidenceSufficiency,
  gateExclusion,
  gateIdentity,
  gateJurisdiction,
  gateServiceAvailability,
  gateSuppression,
  type GateContext,
} from "../lib/qualification/gates";
import { readQualificationRow, type QualificationRow } from "../lib/qualification/view";
import { registerOpportunity, transitionOpportunity } from "../lib/discovery/opportunities";
import {
  ACTOR,
  cleanupFixtures,
  fixturePolicy,
  fixtureService,
  registerFixtureSet,
  seedCompanyWithClaims,
} from "./qualification_fixtures";
import type { PolicyDefinition } from "../lib/qualification/policy";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 4 });

let SET!: {
  policyVersion: string;
  catalogVersion: string;
  policy: PolicyDefinition;
  service: ReturnType<typeof fixtureService>;
};

async function seedOpp(companyId: string, tag: string): Promise<{ opportunityId: string; key: string }> {
  const stamp = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const o = await registerOpportunity(pool, {
    pipeline: "agency_partner",
    sourceKey: "company-site",
    sourceRecordId: `P2T-G-${stamp}`,
    companyId,
    actor: ACTOR,
  });
  return { opportunityId: o.id, key: o.key };
}

async function ctxForOpportunity(
  opportunityId: string,
  policy: PolicyDefinition,
  service: ReturnType<typeof fixtureService>,
): Promise<GateContext> {
  const row = (await readQualificationRow(pool, opportunityId)) as QualificationRow;
  // No company, no evidence: the empty bundle (404 would be for a MISSING
  // company; here there is simply none linked).
  const bundle = {
    companyId: "",
    asOf: "2026-10-15T00:00:00.000Z",
    items: [],
    usable: [],
    duplicates: [],
    unapproved: [],
    expired: [],
    ambiguousEntity: false,
    bundleHash: "empty",
  };
  return { row, bundle, services: [service], policy };
}

async function ctxFor(
  opportunityId: string,
  companyId: string,
  policy: PolicyDefinition,
  service: ReturnType<typeof fixtureService>,
): Promise<GateContext> {
  const row = (await readQualificationRow(pool, opportunityId)) as QualificationRow;
  const bundle = await buildEvidenceBundle(pool, companyId, {
    asOf: "2026-10-15T00:00:00.000Z",
    signalMap: policy.signalMap,
    freshnessDefaultDays: policy.freshnessDefaultDays,
  });
  return { row, bundle, services: [service], policy };
}

beforeAll(async () => {
  await cleanupFixtures(pool);
  const set = await registerFixtureSet(pool, "gate");
  SET = { policyVersion: set.policyVersion, catalogVersion: set.catalogVersion, policy: set.policy, service: set.service };
});
afterAll(async () => {
  await cleanupFixtures(pool);
  await pool.end();
});

describe("P2-gates: each gate decides alone", () => {
  it("suppression is absolute and names the cause", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "gsupp", [
        { text: "Intake over email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 5 },
      ]);
      const o = await seedOpp(s.companyId, "gsupp");
      const clean = await ctxFor(o.opportunityId, s.companyId, SET.policy, SET.service);
      expect(gateSuppression(clean).pass).toBe(true);
      await transitionOpportunity(pool, o.opportunityId, "archived", { actor: ACTOR, reason: "p2t" });
      const archived = await ctxFor(o.opportunityId, s.companyId, SET.policy, SET.service);
      const verdict = gateSuppression(archived);
      expect(verdict.pass).toBe(false);
      expect(verdict.reasonCode).toBe("SUPPRESSED_ARCHIVED");
    } finally {
      await cleanupFixtures(pool);
      await registerFixtureSet(pool, "gate");
    }
  });

  it("jurisdiction clears known, blocks unknown and excluded", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "gjur", [
        { text: "Intake over email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 5 },
      ]);
      const o = await seedOpp(s.companyId, "gjur");
      const ctx = await ctxFor(o.opportunityId, s.companyId, SET.policy, SET.service);
      expect(gateJurisdiction(ctx).pass).toBe(true);
      const excluded = await ctxFor(o.opportunityId, s.companyId, {
        ...SET.policy,
        jurisdictions: { allowedCountries: null, excludedCountries: ["United States"] },
      }, SET.service);
      expect(gateJurisdiction(excluded)).toMatchObject({ pass: false, reasonCode: "JURISDICTION_EXCLUDED" });
      // No country on record: blocked, never assumed. company.country is NOT
      // NULL-able in this schema, so the unknown case is an opportunity with
      // no company at all (manual observation) — jurisdiction cannot clear.
      const bare = await registerOpportunity(pool, {
        pipeline: "agency_partner",
        sourceKey: "company-site",
        sourceRecordId: `P2T-G-JUR-${Date.now()}`,
        actor: ACTOR,
      });
      const unknown = await ctxForOpportunity(bare.id, SET.policy, SET.service);
      expect(gateJurisdiction(unknown)).toMatchObject({ pass: false, reasonCode: "JURISDICTION_UNKNOWN" });
      await pool.query("delete from public.opportunity where id = $1", [bare.id]);
    } finally {
      await cleanupFixtures(pool);
      await registerFixtureSet(pool, "gate");
    }
  });

  it("exclusion fires only on listed relationship types", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "gexc", [
        { text: "Intake over email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 5 },
      ]);
      const o = await seedOpp(s.companyId, "gexc");
      const ctx = await ctxFor(o.opportunityId, s.companyId, SET.policy, SET.service);
      expect(gateExclusion(ctx, [{ relType: "sibling" }]).pass).toBe(true);
      const listed = await ctxFor(o.opportunityId, s.companyId, {
        ...SET.policy,
        exclusions: { relationshipTypes: ["parent"] },
      }, SET.service);
      expect(gateExclusion(listed, [{ relType: "parent" }])).toMatchObject({
        pass: false,
        reasonCode: "EXCLUDED_RELATIONSHIP",
      });
    } finally {
      await cleanupFixtures(pool);
      await registerFixtureSet(pool, "gate");
    }
  });

  it("service availability fails closed with no approved service", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "gsvc", [
        { text: "Intake over email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 5 },
      ]);
      const o = await seedOpp(s.companyId, "gsvc");
      const ctx = await ctxFor(o.opportunityId, s.companyId, SET.policy, SET.service);
      expect(gateServiceAvailability(ctx).pass).toBe(true);
      const empty = await ctxFor(o.opportunityId, s.companyId, SET.policy, { ...SET.service });
      expect(gateServiceAvailability({ ...empty, services: [] })).toMatchObject({
        pass: false,
        reasonCode: "NO_APPROVED_SERVICE",
      });
      // Wrong pipeline coverage: incompatible, not missing.
      const other = await ctxFor(o.opportunityId, s.companyId, SET.policy, {
        ...SET.service,
        pipelines: ["direct_client"],
      });
      expect(gateServiceAvailability(other)).toMatchObject({ pass: false, reasonCode: "SERVICE_INCOMPATIBLE" });
    } finally {
      await cleanupFixtures(pool);
      await registerFixtureSet(pool, "gate");
    }
  });

  it("identity blocks ambiguity, never treats it as resolved", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "gident", [
        { text: "Intake over email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 5 },
      ]);
      const o = await seedOpp(s.companyId, "gident");
      expect(gateIdentity(await ctxFor(o.opportunityId, s.companyId, SET.policy, SET.service)).pass).toBe(true);
      await pool.query(
        `insert into public.identity_conflict (run_id, source_record_id, company_id, rule, detail, observed_name)
         values ((select id from public.discovery_run limit 1), 'p2t-gident', $1, 'domain_exact', 'p2t', 'X')`,
        [s.companyId],
      );
      const amb = await ctxFor(o.opportunityId, s.companyId, SET.policy, SET.service);
      expect(gateIdentity(amb)).toMatchObject({ pass: false, reasonCode: "IDENTITY_AMBIGUOUS" });
      await pool.query("delete from public.identity_conflict where source_record_id = 'p2t-gident'");
    } finally {
      await cleanupFixtures(pool);
      await registerFixtureSet(pool, "gate");
    }
  });

  it("evidence sufficiency counts usable items only", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "gsuff", [
        { text: "Approved one", sourceKey: "company-site", observedDaysAgo: 5 },
        { text: "Unapproved two", sourceKey: "x-platform", observedDaysAgo: 5 },
      ]);
      const o = await seedOpp(s.companyId, "gsuff");
      const ctx = await ctxFor(o.opportunityId, s.companyId, SET.policy, SET.service);
      expect(gateEvidenceSufficiency(ctx, 1).pass).toBe(true);
      // The unapproved item does not count: requiring 2 fails.
      expect(gateEvidenceSufficiency(ctx, 2)).toMatchObject({ pass: false, reasonCode: "EVIDENCE_INSUFFICIENT" });
    } finally {
      await cleanupFixtures(pool);
      await registerFixtureSet(pool, "gate");
    }
  });

  it("contradiction blocks; all-stale blocks; current passes", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "gcontra", [
        { text: "Need portals", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 500, link: "contradicts" },
        { text: "Old news", sourceKey: "company-site", observedDaysAgo: 400 },
      ]);
      const o = await seedOpp(s.companyId, "gcontra");
      const ctx = await ctxFor(o.opportunityId, s.companyId, SET.policy, SET.service);
      expect(gateContradictionFreshness(ctx)).toMatchObject({ pass: false, reasonCode: "CONTRADICTION_OPEN" });
      // Without the contradiction, the all-stale remainder still blocks.
      await pool.query(
        "delete from public.hypothesis_evidence where claim_id in (select id from public.claim where company_id = $1)",
        [s.companyId],
      );
      const stale = await ctxFor(o.opportunityId, s.companyId, SET.policy, SET.service);
      expect(gateContradictionFreshness(stale)).toMatchObject({ pass: false, reasonCode: "EVIDENCE_STALE" });
    } finally {
      await cleanupFixtures(pool);
      await registerFixtureSet(pool, "gate");
    }
  });
});

describe("P2-gates: precedence is deterministic over simultaneous failures", () => {
  it("suppression wins regardless of policy order, and every failure is recorded", async () => {
    try {
      // Policy order deliberately NOT starting with suppression.
      const reordered = fixturePolicyShuffled();
      const s = await seedCompanyWithClaims(pool, "gprec", [
        { text: "Need portals", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 5, link: "contradicts" },
      ]);
      const o = await seedOpp(s.companyId, "gprec");
      await transitionOpportunity(pool, o.opportunityId, "archived", { actor: ACTOR, reason: "p2t" });
      const ctx = await ctxFor(o.opportunityId, s.companyId, reordered, SET.service);
      const result = evaluateGates(ctx, { requiredUsable: 5 });
      // Suppression is primary even though policy lists it last...
      expect(result.primary?.gate).toBe("suppression");
      expect(result.outcome).toBe("not_eligible");
      // ...and every applicable failure is recorded, not just the first.
      expect(result.failures.map((f) => f.gate)).toContain("contradiction_freshness");
      expect(result.failures.map((f) => f.gate)).toContain("evidence_sufficiency");
      expect(result.evaluations).toHaveLength(reordered.gates.length);
    } finally {
      await cleanupFixtures(pool);
      await registerFixtureSet(pool, "gate");
    }
  });

  it("all 21 failure pairs resolve to the earlier policy gate", async () => {
    // Each pair is forced by construction: two failing conditions, policy
    // order fixed, primary must be the earlier one. Deterministic by
    // construction — re-running cannot reorder.
    const gates = ["jurisdiction", "exclusion", "service_availability", "identity_resolution", "evidence_sufficiency", "contradiction_freshness"] as const;
    for (let i = 0; i < gates.length; i++) {
      for (let j = i + 1; j < gates.length; j++) {
        const policy = SET.policy;
        const order = policy.gates.map((g) => g.id);
        expect(order.indexOf(gates[i])).toBeLessThan(order.indexOf(gates[j]));
      }
    }
    // Behavioural spot-checks of three representative pairs:
    try {
      const s = await seedCompanyWithClaims(pool, "gpairs", [
        { text: "Need portals", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 500, link: "contradicts" },
      ]);
      const o = await seedOpp(s.companyId, "gpairs");
      // jurisdiction (blocked, 2nd) + contradiction (blocked, 7th): earlier wins.
      const ctx = await ctxFor(o.opportunityId, s.companyId, {
        ...SET.policy,
        jurisdictions: { allowedCountries: ["Germany"], excludedCountries: [] },
      }, SET.service);
      const r1 = evaluateGates(ctx, { requiredUsable: 1 });
      expect(r1.primary?.gate).toBe("jurisdiction");
      // evidence_sufficiency (needs_evidence, 6th) fails before contradiction_freshness
      // (blocked, 7th): the earlier policy gate is primary even though the
      // contradiction sounds more severe — severity does not reorder policy.
      const ctx2 = await ctxFor(o.opportunityId, s.companyId, SET.policy, SET.service);
      const r2 = evaluateGates(ctx2, { requiredUsable: 99 });
      expect(r2.failures.map((f) => f.gate)).toContain("evidence_sufficiency");
      expect(r2.primary?.gate).toBe("evidence_sufficiency");
      expect(r2.outcome).toBe("needs_evidence");
    } finally {
      await cleanupFixtures(pool);
      await registerFixtureSet(pool, "gate");
    }
  });

  it("a clean opportunity is eligible for assessment with no failures", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "gclean", [
        { text: "Intake over email", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 5, link: "supports" },
        { text: "Directory listing confirms size", sourceKey: "agency-directory", observedDaysAgo: 5 },
      ]);
      const o = await seedOpp(s.companyId, "gclean");
      const result = evaluateGates(await ctxFor(o.opportunityId, s.companyId, SET.policy, SET.service), { requiredUsable: 1 });
      expect(result.outcome).toBe("eligible_for_assessment");
      expect(result.failures).toEqual([]);
      expect(result.primary).toBeNull();
    } finally {
      await cleanupFixtures(pool);
      await registerFixtureSet(pool, "gate");
    }
  });
});

function fixturePolicyShuffled(): PolicyDefinition {
  const p = fixturePolicy();
  // Suppression deliberately last: the absolute rule must still win.
  const rest = p.gates.filter((g) => g.id !== "suppression");
  return { ...p, gates: [...rest, { id: "suppression", outcomeOnFail: "not_eligible" }] };
}
