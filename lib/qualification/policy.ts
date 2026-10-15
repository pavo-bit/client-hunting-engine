// Versioned policy, catalog, rubric and capacity definitions (Part 2).
//
// CONTENT lives in p2.scoring_policy / service_catalog / rubric /
// capacity_profile; LIFECYCLE lives only in p2.reference_version
// (draft -> active -> retired). Nothing here invents values: every constructor
// validates structure, and publication (draft -> active) is an explicit
// operator act. With O10/D-004/D-006/O7 all OPEN there is deliberately no
// approved production content — tests register fixture versions in the test
// database only.
//
// A policy definition (all fields required unless marked):
//   gates: [{id, outcomeOnFail: blocked|needs_evidence|not_eligible}] (order = precedence)
//   jurisdictions: {allowedCountries: string[] | null, excludedCountries: string[]}
//   signalMap: {predicate: signalFamily} (explicit; unmapped predicates are unusable, not defaulted)
//   weights: {dimension: number >= 0} (must cover every scored dimension; need not sum to 1 — normalized)
//   floors: {dimension: number | null} (mandatory minimums; null = no floor)
//   minCoverage: number 0..1 (minimum scored-weight fraction for a composite)
//   bands: [{name, min}] | null (ordered desc; null = no bands permitted)
//   timing: {family: {freshDays, staleDays}} + freshnessDefaultDays
//   ranking: {strategy: 'lexicographic', tiebreak: dimension[]}
//   capacity: {maxActivePursuits: int | null, focusServices: string[], focusPipelines: string[]}
//   exclusions: {relationshipTypes: string[]} (business_relationship rel_types that disqualify)

import type { Pool, PoolClient } from "pg";
import { registerReferenceVersion, setReferenceStatus } from "./cases.ts";

export const DIMENSIONS = [
  "service_fit",
  "need_strength",
  "timing",
  "evidence_confidence",
  "actionability",
  "pursuit_priority",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];
/** Intrinsic dimensions: the composite is built from these only. */
export const INTRINSIC_DIMENSIONS: Dimension[] = [
  "service_fit",
  "need_strength",
  "timing",
  "evidence_confidence",
  "actionability",
];

export const GATE_IDS = [
  "suppression",
  "jurisdiction",
  "exclusion",
  "service_availability",
  "identity_resolution",
  "evidence_sufficiency",
  "contradiction_freshness",
] as const;
export type GateId = (typeof GATE_IDS)[number];

export type GateOutcome = "blocked" | "needs_evidence" | "not_eligible";

export interface PolicyGate {
  id: GateId;
  outcomeOnFail: GateOutcome;
}

export interface PolicyDefinition {
  gates: PolicyGate[];
  jurisdictions: { allowedCountries: string[] | null; excludedCountries: string[] };
  signalMap: Record<string, string>;
  weights: Record<string, number>;
  floors: Record<string, number | null>;
  minCoverage: number;
  bands: { name: string; min: number }[] | null;
  timing: Record<string, { freshDays: number; staleDays: number }>;
  freshnessDefaultDays: number;
  ranking: { strategy: "lexicographic"; tiebreak: Dimension[] };
  capacity: { maxActivePursuits: number | null; focusServices: string[]; focusPipelines: string[] };
  exclusions: { relationshipTypes: string[] };
  /**
   * Deferral limits. OPTIONAL and enforced only when present: numeric limits
   * must come from the approved policy, never invented defaults. Absent =
   * structural single-active-deferral rule only.
   */
  deferral?: { maxDays: number | null; maxLifetime: number | null };
}

export interface ServiceDefinition {
  serviceId: string;
  name: string;
  status: "draft" | "blocked" | "approved" | "retired";
  buyer: string;
  profiles: { agencyTypes: string[]; countries: string[] | null };
  problems: string[];
  signalFamilies: string[];
  antiSignals: { id: string; description: string; disqualifying: boolean }[];
  requiredEvidence: { id: string; description: string }[];
  geography: { regions: string[] | null; deliveryConstraints: string };
  pipelines: ("agency_partner" | "direct_client")[];
  engagementRoutes: string[];
  freshnessRules: Record<string, { freshDays: number; staleDays: number }>;
  effectiveDate: string;
  policyCompat: string[];
  rubricCompat: string[];
}

export interface RubricDimension {
  range: [number, number];
  inputs: string[];
  missingSemantics: string;
  evidence: string;
  rubric: string;
}

export interface CapacityDefinition {
  maxActivePursuits: number | null;
  focusServices: string[];
  focusPipelines: string[];
  notes: string;
}

export interface PolicyError {
  status: number;
  code: string;
  message: string;
}

const fail = (status: number, code: string, message: string): PolicyError => ({
  status,
  code,
  message,
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural validation of a policy definition. Pure; no I/O. */
export function lintPolicy(def: unknown): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(def)) return { ok: false, problems: ["definition must be an object"] };
  // Gates: known ids, unique, valid outcomes.
  if (!Array.isArray(def.gates) || def.gates.length === 0) {
    problems.push("gates must be a non-empty array");
  } else {
    const seen = new Set<string>();
    for (const [i, g] of (def.gates as unknown[]).entries()) {
      if (!isRecord(g)) {
        problems.push(`gates[${i}] must be an object`);
        continue;
      }
      if (!(GATE_IDS as readonly string[]).includes(g.id as string)) {
        problems.push(`gates[${i}].id '${String(g.id)}' is not a registered gate`);
      }
      if (seen.has(g.id as string)) problems.push(`gates[${i}].id '${String(g.id)}' is duplicated`);
      seen.add(g.id as string);
      if (!["blocked", "needs_evidence", "not_eligible"].includes(g.outcomeOnFail as string)) {
        problems.push(`gates[${i}].outcomeOnFail must be blocked|needs_evidence|not_eligible`);
      }
    }
  }
  // Jurisdictions: explicit lists (null allowedCountries = no allow-list restriction, still blocked on unknown).
  if (!isRecord(def.jurisdictions)) problems.push("jurisdictions must be an object");
  else {
    if (
      def.jurisdictions.allowedCountries !== null &&
      (!Array.isArray(def.jurisdictions.allowedCountries) ||
        !(def.jurisdictions.allowedCountries as unknown[]).every((c) => typeof c === "string"))
    ) {
      problems.push("jurisdictions.allowedCountries must be null or a string array");
    }
    if (
      !Array.isArray(def.jurisdictions.excludedCountries) ||
      !(def.jurisdictions.excludedCountries as unknown[]).every((c) => typeof c === "string")
    ) {
      problems.push("jurisdictions.excludedCountries must be a string array");
    }
  }
  if (!isRecord(def.signalMap)) problems.push("signalMap must be an object");
  // Weights: every intrinsic dimension present, finite, non-negative, total > 0.
  if (!isRecord(def.weights)) problems.push("weights must be an object");
  else {
    let total = 0;
    for (const d of INTRINSIC_DIMENSIONS) {
      const w = (def.weights as Record<string, unknown>)[d];
      if (typeof w !== "number" || !Number.isFinite(w) || w < 0) {
        problems.push(`weights.${d} must be a finite non-negative number`);
      } else total += w;
    }
    for (const k of Object.keys(def.weights as object)) {
      if (!(INTRINSIC_DIMENSIONS as readonly string[]).includes(k)) {
        problems.push(`weights.${k} is not a scored dimension (pursuit_priority is derived, never weighted)`);
      }
    }
    if (total <= 0) problems.push("weights must total above zero");
  }
  // Floors: nullable numbers 0..100 for known dimensions.
  if (!isRecord(def.floors)) problems.push("floors must be an object");
  else {
    for (const [k, v] of Object.entries(def.floors as Record<string, unknown>)) {
      if (!(DIMENSIONS as readonly string[]).includes(k)) problems.push(`floors.${k} is not a known dimension`);
      else if (v !== null && (typeof v !== "number" || v < 0 || v > 100)) {
        problems.push(`floors.${k} must be null or 0..100`);
      }
    }
  }
  if (typeof def.minCoverage !== "number" || def.minCoverage < 0 || def.minCoverage > 1) {
    problems.push("minCoverage must be 0..1");
  }
  // Bands: ordered desc by min, or null (no bands permitted).
  if (def.bands !== null) {
    if (!Array.isArray(def.bands) || def.bands.length === 0) problems.push("bands must be null or a non-empty array");
    else {
      let prev = Infinity;
      for (const [i, b] of (def.bands as unknown[]).entries()) {
        if (!isRecord(b) || typeof b.name !== "string" || typeof b.min !== "number") {
          problems.push(`bands[${i}] needs {name: string, min: number}`);
          continue;
        }
        if (!((b.min as number) < prev)) problems.push(`bands[${i}].min must descend`);
        prev = b.min as number;
      }
    }
  }
  // Timing + freshness.
  if (!isRecord(def.timing)) problems.push("timing must be an object");
  else {
    for (const [fam, t] of Object.entries(def.timing as Record<string, unknown>)) {
      if (
        !isRecord(t) ||
        !Number.isInteger(t.freshDays) ||
        (t.freshDays as number) < 0 ||
        !Number.isInteger(t.staleDays) ||
        (t.staleDays as number) < (t.freshDays as number)
      ) {
        problems.push(`timing.${fam} needs {freshDays, staleDays} integers with staleDays >= freshDays`);
      }
    }
  }
  if (!Number.isInteger(def.freshnessDefaultDays) || (def.freshnessDefaultDays as number) < 0) {
    problems.push("freshnessDefaultDays must be a non-negative integer");
  }
  if (!isRecord(def.ranking) || def.ranking.strategy !== "lexicographic" || !Array.isArray(def.ranking.tiebreak)) {
    problems.push("ranking must be {strategy: 'lexicographic', tiebreak: dimension[]}");
  }
  if (!isRecord(def.capacity)) problems.push("capacity must be an object");
  else {
    const c = def.capacity as Record<string, unknown>;
    if (c.maxActivePursuits !== null && (!Number.isInteger(c.maxActivePursuits) || (c.maxActivePursuits as number) < 1)) {
      problems.push("capacity.maxActivePursuits must be null or a positive integer");
    }
    if (!Array.isArray(c.focusServices) || !Array.isArray(c.focusPipelines)) {
      problems.push("capacity.focusServices/focusPipelines must be arrays");
    }
  }
  if (
    !isRecord(def.exclusions) ||
    !Array.isArray(def.exclusions.relationshipTypes) ||
    !(def.exclusions.relationshipTypes as unknown[]).every((t) => typeof t === "string")
  ) {
    problems.push("exclusions.relationshipTypes must be a string array");
  }
  if (def.deferral !== undefined) {
    if (!isRecord(def.deferral)) {
      problems.push("deferral must be an object when present");
    } else {
      const d = def.deferral as Record<string, unknown>;
      if (d.maxDays !== null && d.maxDays !== undefined && (!Number.isInteger(d.maxDays) || (d.maxDays as number) < 1)) {
        problems.push("deferral.maxDays must be null or a positive integer");
      }
      if (d.maxLifetime !== null && d.maxLifetime !== undefined && (!Number.isInteger(d.maxLifetime) || (d.maxLifetime as number) < 1)) {
        problems.push("deferral.maxLifetime must be null or a positive integer");
      }
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true };
}

/** Structural validation of a service definition. Pure; no I/O. */
export function lintService(def: unknown): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(def)) return { ok: false, problems: ["definition must be an object"] };
  const str = (k: string, max: number, required = true): void => {
    const v = def[k];
    if (v === undefined && !required) return;
    if (typeof v !== "string" || v.trim() === "" || v.length > max) {
      problems.push(`${k} must be a 1..${max}-char string`);
    }
  };
  str("serviceId", 80);
  str("name", 200);
  if (!["draft", "blocked", "approved", "retired"].includes(def.status as string)) {
    problems.push("status must be draft|blocked|approved|retired");
  }
  str("buyer", 500);
  const profiles = def.profiles as { agencyTypes?: unknown; countries?: unknown } | null;
  const profilesOk =
    isRecord(def.profiles) &&
    Array.isArray(profiles?.agencyTypes) &&
    (profiles?.agencyTypes as unknown[]).every((t) => typeof t === "string") &&
    (profiles?.countries === null ||
      (Array.isArray(profiles?.countries) &&
        (profiles?.countries as unknown[]).every((t) => typeof t === "string")));
  if (!profilesOk) {
    problems.push("profiles needs {agencyTypes: string[], countries: string[] | null}");
  }
  for (const k of ["problems", "engagementRoutes", "policyCompat", "rubricCompat"] as const) {
    if (!Array.isArray(def[k]) || !(def[k] as unknown[]).every((t) => typeof t === "string")) {
      problems.push(`${k} must be a string array`);
    }
  }
  if (!Array.isArray(def.signalFamilies) || def.signalFamilies.length === 0) {
    problems.push("signalFamilies must be a non-empty string array");
  }
  for (const k of ["antiSignals", "requiredEvidence"] as const) {
    if (!Array.isArray(def[k])) problems.push(`${k} must be an array`);
  }
  if (!isRecord(def.geography) || typeof def.geography.deliveryConstraints !== "string") {
    problems.push("geography needs {regions: string[] | null, deliveryConstraints: string}");
  }
  if (
    !Array.isArray(def.pipelines) ||
    def.pipelines.length === 0 ||
    !(def.pipelines as unknown[]).every((p) => p === "agency_partner" || p === "direct_client")
  ) {
    problems.push("pipelines must be a non-empty array of agency_partner|direct_client");
  }
  if (!isRecord(def.freshnessRules)) problems.push("freshnessRules must be an object");
  str("effectiveDate", 10);
  return problems.length > 0 ? { ok: false, problems } : { ok: true };
}

/** Structural validation of a rubric document. Pure; no I/O. */
export function lintRubric(doc: unknown): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(doc)) return { ok: false, problems: ["rubric must be an object"] };
  for (const d of DIMENSIONS) {
    const r = (doc as Record<string, unknown>)[d];
    if (!isRecord(r)) {
      problems.push(`dimension ${d} is missing`);
      continue;
    }
    if (
      !Array.isArray(r.range) ||
      r.range.length !== 2 ||
      typeof r.range[0] !== "number" ||
      typeof r.range[1] !== "number" ||
      (r.range[0] as number) >= (r.range[1] as number)
    ) {
      problems.push(`dimension ${d}.range must be [lo, hi] with lo < hi`);
    }
    for (const k of ["missingSemantics", "evidence", "rubric"] as const) {
      if (typeof r[k] !== "string" || (r[k] as string).trim() === "") {
        problems.push(`dimension ${d}.${k} must be a non-empty string`);
      }
    }
    if (!Array.isArray(r.inputs)) problems.push(`dimension ${d}.inputs must be an array`);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true };
}

/** Structural validation of a capacity profile. Pure; no I/O. */
export function lintCapacity(def: unknown): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(def)) return { ok: false, problems: ["capacity must be an object"] };
  if (def.maxActivePursuits !== null && (!Number.isInteger(def.maxActivePursuits) || (def.maxActivePursuits as number) < 1)) {
    problems.push("maxActivePursuits must be null or a positive integer");
  }
  if (!Array.isArray(def.focusServices) || !Array.isArray(def.focusPipelines) || typeof def.notes !== "string") {
    problems.push("capacity needs {maxActivePursuits, focusServices[], focusPipelines[], notes: string}");
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true };
}

function requireActor(actor: string): void {
  if (!(actor ?? "").trim()) throw fail(422, "actor_required", "acting operator identity is required");
}

/**
 * Store a policy draft: validates, inserts content, registers the version as
 * draft. Activation is a separate explicit step (publishPolicy) — a draft or
 * dry run never alters live rankings because nothing reads drafts.
 */
export async function draftPolicy(
  db: Pool | PoolClient,
  version: string,
  definition: PolicyDefinition,
  actor: string,
): Promise<void> {
  requireActor(actor);
  const lint = lintPolicy(definition);
  if (!lint.ok) {
    throw fail(422, "bad_policy_definition", `policy failed lint: ${lint.problems.join("; ")}`.slice(0, 2000));
  }
  await db.query(
    `insert into p2.scoring_policy (policy_version, definition, recorded_by)
     values ($1, $2, $3) on conflict (policy_version) do nothing`,
    [version, JSON.stringify(definition), actor.trim().slice(0, 200)],
  );
  await registerReferenceVersion(db, "policy", version, actor, "policy draft stored (not active)");
}

/** Explicit operator publication: draft -> active. The moment rankings may use it. */
export async function publishPolicy(db: Pool | PoolClient, version: string, actor: string): Promise<void> {
  requireActor(actor);
  const found = await db.query("select policy_version from p2.scoring_policy where policy_version = $1", [version]);
  if (found.rows.length === 0) throw fail(404, "policy_not_found", "no stored draft for that policy version");
  await setReferenceStatus(db, "policy", version, "active", actor);
}

/** Read a policy version's content (any status; callers check activation). */
export async function readPolicy(db: Pool | PoolClient, version: string): Promise<PolicyDefinition> {
  const r = await db.query("select definition from p2.scoring_policy where policy_version = $1", [version]);
  if (r.rows.length === 0) throw fail(404, "policy_not_found", "policy version is not stored");
  return r.rows[0].definition as PolicyDefinition;
}

/** The active policy version, or null when none is published (current truth: none). */
export async function activePolicyVersion(db: Pool | PoolClient): Promise<string | null> {
  const r = await db.query(
    "select version from p2.reference_version where kind = 'policy' and status = 'active' order by recorded_at desc limit 1",
  );
  return (r.rows[0]?.version as string | undefined) ?? null;
}

/** Store one service definition inside a catalog version (any per-service status). */
export async function draftService(
  db: Pool | PoolClient,
  catalogVersion: string,
  definition: ServiceDefinition,
  actor: string,
): Promise<void> {
  requireActor(actor);
  const lint = lintService(definition);
  if (!lint.ok) {
    throw fail(422, "bad_service_definition", `service failed lint: ${lint.problems.join("; ")}`.slice(0, 2000));
  }
  await db.query(
    `insert into p2.service_catalog (catalog_version, service_id, definition, recorded_by)
     values ($1, $2, $3, $4)
     on conflict (catalog_version, service_id) do nothing`,
    [catalogVersion, definition.serviceId, JSON.stringify(definition), actor.trim().slice(0, 200)],
  );
  await registerReferenceVersion(db, "service_catalog", catalogVersion, actor, "catalog draft stored (not active)");
}

/** Explicit operator publication of a whole catalog version. */
export async function publishCatalog(db: Pool | PoolClient, catalogVersion: string, actor: string): Promise<void> {
  requireActor(actor);
  const found = await db.query("select 1 from p2.service_catalog where catalog_version = $1 limit 1", [catalogVersion]);
  if (found.rows.length === 0) throw fail(404, "catalog_not_found", "no stored draft for that catalog version");
  await setReferenceStatus(db, "service_catalog", catalogVersion, "active", actor);
}

/** Approved services of an ACTIVE catalog version. Draft/blocked/retired services are never listed. */
export async function approvedServices(
  db: Pool | PoolClient,
  catalogVersion: string,
): Promise<ServiceDefinition[]> {
  const active = await db.query(
    "select status from p2.reference_version where kind = 'service_catalog' and version = $1",
    [catalogVersion],
  );
  if (active.rows.length === 0 || active.rows[0].status !== "active") {
    throw fail(409, "catalog_not_active", "only an active catalog version exposes approved services");
  }
  const r = await db.query("select definition from p2.service_catalog where catalog_version = $1", [catalogVersion]);
  return (r.rows as { definition: ServiceDefinition }[])
    .map((x) => x.definition)
    .filter((d) => d.status === "approved");
}

/** Store a rubric document as draft; activation is explicit like policy. */
export async function draftRubric(
  db: Pool | PoolClient,
  version: string,
  dimensions: Record<string, RubricDimension>,
  actor: string,
): Promise<void> {
  requireActor(actor);
  const lint = lintRubric(dimensions);
  if (!lint.ok) {
    throw fail(422, "bad_rubric", `rubric failed lint: ${lint.problems.join("; ")}`.slice(0, 2000));
  }
  await db.query(
    `insert into p2.rubric (rubric_version, dimensions, recorded_by)
     values ($1, $2, $3) on conflict (rubric_version) do nothing`,
    [version, JSON.stringify(dimensions), actor.trim().slice(0, 200)],
  );
  await registerReferenceVersion(db, "rubric", version, actor, "rubric draft stored (not active)");
}

export async function publishRubric(db: Pool | PoolClient, version: string, actor: string): Promise<void> {
  requireActor(actor);
  const found = await db.query("select 1 from p2.rubric where rubric_version = $1", [version]);
  if (found.rows.length === 0) throw fail(404, "rubric_not_found", "no stored draft for that rubric version");
  await setReferenceStatus(db, "rubric", version, "active", actor);
}

/** Store a capacity profile as draft; activation is explicit like policy. */
export async function draftCapacity(
  db: Pool | PoolClient,
  version: string,
  definition: CapacityDefinition,
  actor: string,
): Promise<void> {
  requireActor(actor);
  const lint = lintCapacity(definition);
  if (!lint.ok) {
    throw fail(422, "bad_capacity", `capacity failed lint: ${lint.problems.join("; ")}`.slice(0, 2000));
  }
  await db.query(
    `insert into p2.capacity_profile (capacity_version, definition, recorded_by)
     values ($1, $2, $3) on conflict (capacity_version) do nothing`,
    [version, JSON.stringify(definition), actor.trim().slice(0, 200)],
  );
  await registerReferenceVersion(db, "capacity", version, actor, "capacity draft stored (not active)");
}

export async function publishCapacity(db: Pool | PoolClient, version: string, actor: string): Promise<void> {
  requireActor(actor);
  const found = await db.query("select 1 from p2.capacity_profile where capacity_version = $1", [version]);
  if (found.rows.length === 0) throw fail(404, "capacity_not_found", "no stored draft for that capacity version");
  await setReferenceStatus(db, "capacity", version, "active", actor);
}

/** Dry-run a policy against fixture inputs without publishing anything. Pure shape check + lint. */
export function dryRunPolicy(definition: unknown): { ok: true } | { ok: false; problems: string[] } {
  return lintPolicy(definition);
}
