// Qualification gates (Part 2, §6). Pure rules, independently tested.
//
// Each gate is a pure function of (view row, evidence bundle, policy context):
// no I/O, no clock, no randomness. The policy determines gate ORDER
// (precedence) and each gate's failure outcome class; this module only defines
// the rules and the reason-code registry.
//
// Outcome vocabulary (project lifecycle words, no duplicates invented):
//   blocked              — a mandatory condition is unresolved or fails;
//   needs_evidence       — possibly relevant, evidence insufficient;
//   eligible_for_assessment — may be scored under the current policy;
//   not_eligible         — an approved hard gate rejects it.
//
// Suppression is absolute: it is evaluated first regardless of policy order,
// and no score, override flag or service-fit result can lift it. There is no
// override parameter anywhere in this module — by construction, not by
// convention.
//
// Reason-code registry (stable strings; explanations cite them):
export const REASON_CODES = [
  "SUPPRESSED_MERGED",
  "SUPPRESSED_ARCHIVED",
  "JURISDICTION_UNKNOWN",
  "JURISDICTION_EXCLUDED",
  "EXCLUDED_RELATIONSHIP",
  "NO_APPROVED_SERVICE",
  "SERVICE_INCOMPATIBLE",
  "IDENTITY_AMBIGUOUS",
  "IDENTITY_UNRESOLVED",
  "EVIDENCE_INSUFFICIENT",
  "CONTRADICTION_OPEN",
  "EVIDENCE_STALE",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

import type { PolicyDefinition } from "./policy.ts";
import type { ServiceDefinition } from "./policy.ts";
import type { EvidenceBundle } from "./evidence.ts";
import type { QualificationRow } from "./view.ts";

export type GateVerdict =
  | { pass: true; reasonCode: null; detail: string }
  | { pass: false; reasonCode: ReasonCode; detail: string };

export interface GateContext {
  row: QualificationRow;
  bundle: EvidenceBundle;
  /** Approved services of the active catalog (empty = none approved). */
  services: ServiceDefinition[];
  policy: PolicyDefinition;
}

const pass = (detail: string): GateVerdict => ({ pass: true, reasonCode: null, detail });
const block = (reasonCode: ReasonCode, detail: string): GateVerdict => ({
  pass: false,
  reasonCode,
  detail,
});

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** 1. Suppression and do-not-contact. Absolute: evaluated before policy order. */
export function gateSuppression(ctx: GateContext): GateVerdict {
  const suppression = str(ctx.row.suppression_reason);
  if (suppression === "company_merged") {
    return block("SUPPRESSED_MERGED", "business superseded by a canonical record — non-actionable");
  }
  if (suppression === "opportunity_archived") {
    return block("SUPPRESSED_ARCHIVED", "opportunity archived by the operator — non-actionable");
  }
  if (suppression !== null) {
    return block("SUPPRESSED_ARCHIVED", `suppressed (${suppression}) — non-actionable`);
  }
  return pass("no suppression flag");
}

/** 2. Approved jurisdiction and legal/commercial constraints. */
export function gateJurisdiction(ctx: GateContext): GateVerdict {
  const country = str(ctx.row.company_country);
  const { allowedCountries, excludedCountries } = ctx.policy.jurisdictions;
  if (!country) {
    return block("JURISDICTION_UNKNOWN", "company country unknown — jurisdiction cannot be cleared");
  }
  if (excludedCountries.map((c) => c.toLowerCase()).includes(country.toLowerCase())) {
    return block("JURISDICTION_EXCLUDED", `${country} is on the policy exclusion list`);
  }
  if (allowedCountries !== null && !allowedCountries.map((c) => c.toLowerCase()).includes(country.toLowerCase())) {
    return block("JURISDICTION_EXCLUDED", `${country} is not on the policy allow-list`);
  }
  return pass(`jurisdiction clear (${country})`);
}

/** 3. Exclusion and relationship conflicts. */
export function gateExclusion(ctx: GateContext, relationships: { relType: string }[]): GateVerdict {
  const excluded = ctx.policy.exclusions.relationshipTypes.map((t) => t.toLowerCase());
  const hit = relationships.find((r) => excluded.includes(r.relType.toLowerCase()));
  if (hit) {
    return block("EXCLUDED_RELATIONSHIP", `excluded relationship type present: ${hit.relType}`);
  }
  return pass("no excluded relationship");
}

/** 4. Approved service availability and compatibility. */
export function gateServiceAvailability(ctx: GateContext): GateVerdict {
  const pipeline = String(ctx.row.pipeline);
  const agencyType = str(ctx.row.company_agency_type);
  const country = str(ctx.row.company_country);
  const compatible = ctx.services.filter(
    (s) =>
      s.pipelines.includes(pipeline as "agency_partner" | "direct_client") &&
      (s.profiles.agencyTypes.length === 0 || (agencyType !== null && s.profiles.agencyTypes.includes(agencyType))) &&
      (s.profiles.countries === null || (country !== null && s.profiles.countries.includes(country))),
  );
  if (ctx.services.length === 0) {
    return block("NO_APPROVED_SERVICE", "no approved service in the active catalog — nothing can be pursued");
  }
  if (compatible.length === 0) {
    return block(
      "SERVICE_INCOMPATIBLE",
      `no approved service covers pipeline=${pipeline} agency=${agencyType ?? "?"} country=${country ?? "?"}`,
    );
  }
  return pass(`${compatible.length} compatible approved service(s): ${compatible.map((s) => s.serviceId).join(", ")}`);
}

/** 5. Identity and entity-resolution requirements. */
export function gateIdentity(ctx: GateContext): GateVerdict {
  if (ctx.bundle.ambiguousEntity) {
    return block("IDENTITY_AMBIGUOUS", "open identity conflict — match unverified, never treated as resolved");
  }
  const companyId = str(ctx.row.company_id);
  if (!companyId) {
    return block("IDENTITY_UNRESOLVED", "no canonical company linked — nothing to qualify");
  }
  return pass("identity resolved to a canonical company with no open conflict");
}

/** 6. Evidence sufficiency. */
export function gateEvidenceSufficiency(
  ctx: GateContext,
  requiredUsable: number,
): GateVerdict {
  const n = ctx.bundle.usable.length;
  if (n < requiredUsable) {
    return block(
      "EVIDENCE_INSUFFICIENT",
      `${n} usable evidence item(s), ${requiredUsable} required — possibly relevant, evidence insufficient`,
    );
  }
  return pass(`${n} usable evidence item(s) meet the sufficiency bar (${requiredUsable})`);
}

/** 7. Contradiction and freshness checks. */
export function gateContradictionFreshness(ctx: GateContext): GateVerdict {
  const open = ctx.bundle.items.filter((i) => i.polarity === "contradicts");
  if (open.length > 0) {
    return block(
      "CONTRADICTION_OPEN",
      `${open.length} open contradicting claim(s) — must be resolved, discounted or flagged by explicit rule first`,
    );
  }
  const usable = ctx.bundle.usable;
  if (usable.length > 0 && usable.every((i) => i.freshness === "stale")) {
    return block(
      "EVIDENCE_STALE",
      "all usable evidence is stale — refresh before scoring",
    );
  }
  return pass("no open contradiction; usable evidence is current");
}

export interface GateEvaluation {
  gate: string;
  pass: boolean;
  reasonCode: ReasonCode | null;
  detail: string;
  outcomeOnFail: string | null;
}

export type QualificationOutcome =
  | "blocked"
  | "needs_evidence"
  | "eligible_for_assessment"
  | "not_eligible";

export interface QualificationResult {
  outcome: QualificationOutcome;
  /** Every gate evaluated, in policy order (suppression always first). */
  evaluations: GateEvaluation[];
  /** Failing gates only, in policy order. */
  failures: GateEvaluation[];
  /** The primary outcome source: first failure in precedence order, if any. */
  primary: GateEvaluation | null;
}

const GATE_FNS: Record<string, (ctx: GateContext) => GateVerdict> = {
  suppression: gateSuppression,
  jurisdiction: gateJurisdiction,
  service_availability: gateServiceAvailability,
  identity_resolution: gateIdentity,
  contradiction_freshness: gateContradictionFreshness,
};

/**
 * Evaluate every gate; the primary outcome is the FIRST failure in policy
 * order (suppression pinned before the policy list — absolute). Deterministic:
 * same inputs always produce the same outcome and the same primary.
 *
 * `exclusion` and `evidence_sufficiency` take caller inputs (relationships,
 * required count) because they read beyond the bundle; the remaining gates
 * read the context alone.
 */
export function evaluateGates(
  ctx: GateContext,
  extra: { relationships?: { relType: string }[]; requiredUsable?: number } = {},
): QualificationResult {
  const evaluations: GateEvaluation[] = [];
  const outcomeOf = (id: string): string | null =>
    ctx.policy.gates.find((g) => g.id === id)?.outcomeOnFail ?? null;

  const run = (id: string, verdict: GateVerdict): void => {
    evaluations.push({
      gate: id,
      pass: verdict.pass,
      reasonCode: verdict.reasonCode,
      detail: verdict.detail,
      outcomeOnFail: verdict.pass ? null : outcomeOf(id),
    });
  };

  // Suppression first, always — absolute, not policy-ordered.
  run("suppression", gateSuppression(ctx));
  for (const g of ctx.policy.gates) {
    if (g.id === "suppression") continue; // already evaluated; never twice
    if (g.id === "exclusion") {
      run(g.id, gateExclusion(ctx, extra.relationships ?? []));
    } else if (g.id === "evidence_sufficiency") {
      run(g.id, gateEvidenceSufficiency(ctx, extra.requiredUsable ?? 1));
    } else {
      const fn = GATE_FNS[g.id];
      if (!fn) {
        evaluations.push({
          gate: g.id,
          pass: false,
          reasonCode: null,
          detail: `unknown gate '${g.id}' — policy references an unregistered gate`,
          outcomeOnFail: g.outcomeOnFail,
        });
        continue;
      }
      run(g.id, fn(ctx));
    }
  }
  const failures = evaluations.filter((e) => !e.pass);
  const primary = failures[0] ?? null;
  const outcome: QualificationOutcome =
    primary === null
      ? "eligible_for_assessment"
      : (primary.outcomeOnFail as QualificationOutcome);
  return { outcome, evaluations, failures, primary };
}
