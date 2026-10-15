/**
 * Shared Part 2 fixtures (NOT a test file — vitest only runs *.test.ts).
 *
 * Everything here is synthetic and namespaced `p2t-`. Fixture policy,
 * catalog, rubric and capacity versions are registered in the TEST database
 * only, and always as drafts-then-published by the test itself (publication
 * is an explicit act even in tests). NOTHING here touches the dev database,
 * and nothing here is an approved production value: O10/D-004/D-006/O7 stay
 * OPEN, so these fixtures can never leak into production content.
 */
import type { Pool } from "pg";
import { createCompany } from "../lib/intake/import";
import {
  draftCapacity,
  draftPolicy,
  draftRubric,
  draftService,
  publishCapacity,
  publishCatalog,
  publishPolicy,
  publishRubric,
  type CapacityDefinition,
  type PolicyDefinition,
  type RubricDimension,
  type ServiceDefinition,
} from "../lib/qualification/policy";

export const ACTOR = "p2t";

/** A structurally valid fixture policy. Override parts per test. */
export function fixturePolicy(over: Partial<PolicyDefinition> = {}): PolicyDefinition {
  return {
    gates: [
      { id: "suppression", outcomeOnFail: "not_eligible" },
      { id: "jurisdiction", outcomeOnFail: "blocked" },
      { id: "exclusion", outcomeOnFail: "not_eligible" },
      { id: "service_availability", outcomeOnFail: "not_eligible" },
      { id: "identity_resolution", outcomeOnFail: "blocked" },
      { id: "evidence_sufficiency", outcomeOnFail: "needs_evidence" },
      { id: "contradiction_freshness", outcomeOnFail: "blocked" },
    ],
    jurisdictions: { allowedCountries: ["United States", "Germany"], excludedCountries: ["Nowhere"] },
    signalMap: { identity: "identity_proof", "need-portal": "need", "need-mobile": "need", "timing-hire": "timing-cue" },
    weights: {
      service_fit: 0.25,
      need_strength: 0.25,
      timing: 0.15,
      evidence_confidence: 0.2,
      actionability: 0.15,
    },
    floors: {
      service_fit: null,
      need_strength: null,
      timing: null,
      evidence_confidence: 30,
      actionability: null,
      pursuit_priority: null,
    },
    minCoverage: 0.5,
    bands: [
      { name: "Elite", min: 85 },
      { name: "Qualified", min: 65 },
      { name: "Watch", min: 40 },
    ],
    timing: {
      need: { freshDays: 90, staleDays: 365 },
      "timing-cue": { freshDays: 30, staleDays: 180 },
      identity_proof: { freshDays: 365, staleDays: 1095 },
    },
    freshnessDefaultDays: 90,
    ranking: { strategy: "lexicographic", tiebreak: ["evidence_confidence", "need_strength"] },
    capacity: { maxActivePursuits: 10, focusServices: [], focusPipelines: [] },
    exclusions: { relationshipTypes: [] },
    // Test-only deferral limits (not approved policy — fixtures only).
    deferral: { maxDays: 30, maxLifetime: 3 },
    ...over,
  };
}

/** An approved fixture service (status approved — usable only from an ACTIVE catalog in tests). */
export function fixtureService(over: Partial<ServiceDefinition> = {}): ServiceDefinition {
  return {
    serviceId: "portal-build",
    name: "Fixture: client portal build",
    status: "approved",
    buyer: "digital agencies with email-based client intake",
    profiles: { agencyTypes: ["web_development"], countries: null },
    problems: ["email-based intake does not scale"],
    signalFamilies: ["need", "timing-cue"],
    antiSignals: [{ id: "present_confirmed", description: "already operates a client portal", disqualifying: true }],
    requiredEvidence: [{ id: "need-proof", description: "evidence of intake pain" }],
    geography: { regions: null, deliveryConstraints: "remote-first, US/EU hours" },
    pipelines: ["agency_partner"],
    engagementRoutes: ["outbound-email"],
    freshnessRules: { need: { freshDays: 90, staleDays: 365 } },
    effectiveDate: "2026-01-01",
    policyCompat: ["p2t-pol"],
    rubricCompat: ["p2t-rub"],
    ...over,
  };
}

export function fixtureRubric(): Record<string, RubricDimension> {
  const dim = (rubric: string, inputs: string[]): RubricDimension => ({
    range: [0, 100],
    inputs,
    missingSemantics: "unscored (null), excluded from the composite, counted against coverage — never imputed, never zero-filled",
    evidence: "cited claim ids in evidenceRefs",
    rubric,
  });
  return {
    service_fit: dim("profile match 50 + family coverage share", ["compatible service", "usable evidence families"]),
    need_strength: dim("25/group + 10/supporting + grade quarter", ["usable need-family evidence"]),
    timing: dim("strongest decayed recency signal", ["dated usable evidence", "family decay rules"]),
    evidence_confidence: dim("grade average, independence bonus, review penalty", ["usable evidence grades/groups"]),
    actionability: dim("domain 40 + confirmed channel 30 + timeline 30/15", ["domain", "operator answers"]),
    pursuit_priority: dim("composite + capacity alignment only", ["composite", "capacity profile"]),
  };
}

export function fixtureCapacity(over: Partial<CapacityDefinition> = {}): CapacityDefinition {
  return {
    maxActivePursuits: 5,
    focusServices: ["portal-build"],
    focusPipelines: ["agency_partner"],
    notes: "fixture capacity",
    ...over,
  };
}

export interface FixtureSet {
  policyVersion: string;
  catalogVersion: string;
  rubricVersion: string;
  capacityVersion: string;
  policy: PolicyDefinition;
  service: ServiceDefinition;
  rubric: Record<string, RubricDimension>;
  capacity: CapacityDefinition;
}

/** Register + publish a full fixture set in the test DB. Versions namespaced per tag. */
export async function registerFixtureSet(pool: Pool, tag: string): Promise<FixtureSet> {
  const stamp = `${tag}-${Date.now()}`;
  const policyVersion = `p2t-pol-${stamp}`;
  const catalogVersion = `p2t-cat-${stamp}`;
  const rubricVersion = `p2t-rub-${stamp}`;
  const capacityVersion = `p2t-cap-${stamp}`;
  const policy = fixturePolicy();
  const service = fixtureService();
  const rubric = fixtureRubric();
  const capacity = fixtureCapacity();
  await draftPolicy(pool, policyVersion, policy, ACTOR);
  await draftService(pool, catalogVersion, service, ACTOR);
  await draftRubric(pool, rubricVersion, rubric, ACTOR);
  await draftCapacity(pool, capacityVersion, capacity, ACTOR);
  await publishPolicy(pool, policyVersion, ACTOR);
  await publishCatalog(pool, catalogVersion, ACTOR);
  await publishRubric(pool, rubricVersion, ACTOR);
  await publishCapacity(pool, capacityVersion, ACTOR);
  // Trust registry for fixture sources (test DB only).
  for (const [key, grade, approved, group] of [
    ["company-site", "B", true, "web"],
    ["agency-directory", "B", true, "directories"],
    ["registry-generic", "A", true, "registries"],
    ["hiring-platform", "C", true, "job-boards"],
  ] as const) {
    await pool.query(
      `insert into p2.source_trust (source_key, trust_grade, approved_for_scoring, independence_group, updated_by)
       values ($1, $2, $3, $4, $5)
       on conflict (source_key) do update set
         trust_grade = excluded.trust_grade,
         approved_for_scoring = excluded.approved_for_scoring,
         independence_group = excluded.independence_group,
         updated_by = excluded.updated_by,
         updated_at = now()`,
      [key, grade, approved, group, ACTOR],
    );
  }
  return { policyVersion, catalogVersion, rubricVersion, capacityVersion, policy, service, rubric, capacity };
}

export interface ClaimSpec {
  text: string;
  sourceKey?: string;
  status?: string;
  predicate?: string | null;
  observedDaysAgo?: number | null;
  expiresInDays?: number | null;
  reliability?: string;
  credibility?: number;
  needsReview?: boolean;
  suppressedSnapshot?: boolean;
  link?: "supports" | "contradicts" | "contextual";
  /** Override the snapshot URL (adversarial-URL fixtures; validated on read, never fetched). */
  url?: string;
}

export async function seedCompanyWithClaims(
  pool: Pool,
  tag: string,
  specs: ClaimSpec[],
  extra: { registryId?: string; countryCode?: string; agencyType?: string; country?: string } = {},
): Promise<{ companyId: string; claimIds: string[] }> {
  const stamp = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const co = await createCompany(
    pool,
    {
      name: `P2t ${tag} Co`,
      domain: `p2t-${stamp}.example`,
      agencyType: extra.agencyType ?? "web_development",
      country: extra.country ?? "United States",
      countryCode: extra.countryCode ?? "US",
      registryId: extra.registryId ?? "",
    },
    ACTOR,
  );
  const claimIds: string[] = [];
  const links: { claimId: string; polarity: string }[] = [];
  for (const [i, spec] of specs.entries()) {
    const sourceKey = spec.sourceKey ?? "company-site";
    const observed = spec.observedDaysAgo === null ? null : daysAgo(spec.observedDaysAgo ?? 10);
    const snap = await pool.query(
      `insert into public.snapshot
         (company_id, source_key, url, fetched_at, sha256, retention_class, suppressed, content_excerpt)
       values ($1, $2, $3, $4, $5, 'page', $6, $7)
       returning id`,
      [
        co.companyId,
        sourceKey,
        spec.url ?? `https://example.com/p2t/${stamp}/${i}`,
        (observed ?? new Date()).toISOString(),
        "a".repeat(64),
        spec.suppressedSnapshot === true,
        `p2t excerpt ${i}`,
      ],
    );
    const claim = await pool.query(
      `insert into public.claim
         (company_id, snapshot_id, claim_text, claim_status, source_reliability,
          info_credibility, observed_at, expires_at, predicate, needs_review)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning id`,
      [
        co.companyId,
        snap.rows[0].id,
        spec.text,
        spec.status ?? "observed",
        spec.reliability ?? "B",
        spec.credibility ?? 2,
        observed?.toISOString() ?? null,
        spec.expiresInDays === null || spec.expiresInDays === undefined
          ? null
          : new Date(Date.now() + spec.expiresInDays * 86_400_000).toISOString(),
        spec.predicate ?? null,
        spec.needsReview === true,
      ],
    );
    claimIds.push(claim.rows[0].id as string);
    if (spec.link) links.push({ claimId: claim.rows[0].id as string, polarity: spec.link });
  }
  if (links.length > 0) {
    const hyp = await pool.query(
      `insert into public.hypothesis (company_id, title, opportunity_category, status)
       values ($1, $2, 'portals_dashboards', 'needs_review') returning id`,
      [co.companyId, `P2t hypothesis ${stamp}`],
    );
    for (const l of links) {
      await pool.query(
        `insert into public.hypothesis_evidence (hypothesis_id, claim_id, polarity, note)
         values ($1, $2, $3, 'p2t')`,
        [hyp.rows[0].id, l.claimId, l.polarity],
      );
    }
  }
  return { companyId: co.companyId, claimIds };
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

/** Remove all p2t fixture rows (test DB only). */
export async function cleanupFixtures(pool: Pool): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("delete from p2.event_inbox where consumer_name like 'p2t-%'");
    await c.query("delete from p2.consumer_watermark where consumer_name like 'p2t-%'");
    await c.query("delete from p2.idempotency_record where scope like 'p2t%' or key like 'p2t-%'");
    // Research tasks and negative findings reference p2t cases: remove through
    // the case join (their own text carries no p2t marker by design).
    await c.query(
      "delete from p2.research_task where case_id in (select case_id from p2.case where discovery_opportunity_key like '%p2t-%')",
    );
    await c.query(
      "delete from p2.negative_finding where case_id in (select case_id from p2.case where discovery_opportunity_key like '%p2t-%')",
    );
    await c.query("delete from p2.case where discovery_opportunity_key like '%p2t-%'");
    await c.query("delete from p2.ranking_snapshot where created_by = $1", [ACTOR]);
    await c.query(
      "delete from p2.reference_version where version like 'p2t-%' and recorded_by = $1",
      [ACTOR],
    );
    await c.query("delete from p2.scoring_policy where policy_version like 'p2t-%'");
    await c.query("delete from p2.service_catalog where catalog_version like 'p2t-%'");
    await c.query("delete from p2.rubric where rubric_version like 'p2t-%'");
    await c.query("delete from p2.capacity_profile where capacity_version like 'p2t-%'");
    await c.query("delete from p2.source_trust where updated_by = $1", [ACTOR]);
    await c.query("delete from public.opportunity where opportunity_key like '%p2t-%'");
    // Hypothesis links reference claims: remove links, then hypotheses, before
    // their companies (FK order, not cascade reliance).
    await c.query(
      "delete from public.hypothesis_evidence where hypothesis_id in (select id from public.hypothesis where title like 'P2t hypothesis%')",
    );
    await c.query("delete from public.hypothesis where title like 'P2t hypothesis%'");
    await c.query(
      "update public.company set merged_into = null where domain_norm like 'p2t-%' and merged_into is not null",
    );
    await c.query("delete from public.company where domain_norm like 'p2t-%'");
  } finally {
    c.release();
  }
}
