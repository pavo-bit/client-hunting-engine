// Qualification state hashing (Part 1).
//
// A case records the exact Discovery state it was reconciled against as
// `discovery_state_hash`. Reconciliation recomputes the hash from the CURRENT
// qualification-view row and compares: equal means "Phase 2 is looking at what
// Discovery shows", different means drift (Discovery moved on).
//
// What the hash covers: every view field that describes Discovery's CURRENT
// truth about the opportunity (statuses, supersession, latest eligibility
// decision, evidence and provenance COUNTS). What it deliberately excludes:
// timestamps (clocks are not state), operator attribution (not a qualification
// input and not granted to the Phase 2 role), and the event stream position
// (delivery progress, not Discovery truth).
//
// Canonical form: fixed key order, nulls preserved, arrays sorted. The same
// input bytes always produce the same hash, in any process.

import { createHash } from "crypto";

export interface DiscoveryStateInput {
  opportunity_status: string;
  solution_status: string;
  rule_id: string | null;
  company_merged_into: string | null;
  suppression_reason: string | null;
  eligibility_version: number | null;
  eligibility_decision: string | null;
  eligibility_policy_version: string | null;
  evidence_claims_total: number;
  evidence_claims_observed: number;
  evidence_claims_corroborated: number;
  evidence_claims_inferred: number;
  evidence_claims_assumed: number;
  evidence_claims_disputed: number;
  evidence_contradicted_claims: number;
  evidence_claims_needing_review: number;
  provenance_sources_total: number;
  provenance_source_keys: string[] | null;
  provenance_records_failed: number;
}

/** sha256 hex over the canonical state bytes. */
export function discoveryStateHash(input: DiscoveryStateInput): string {
  const canonical = {
    opportunity_status: input.opportunity_status,
    solution_status: input.solution_status,
    rule_id: input.rule_id,
    company_merged_into: input.company_merged_into,
    suppression_reason: input.suppression_reason,
    eligibility_version: input.eligibility_version,
    eligibility_decision: input.eligibility_decision,
    eligibility_policy_version: input.eligibility_policy_version,
    evidence_claims_total: input.evidence_claims_total,
    evidence_claims_observed: input.evidence_claims_observed,
    evidence_claims_corroborated: input.evidence_claims_corroborated,
    evidence_claims_inferred: input.evidence_claims_inferred,
    evidence_claims_assumed: input.evidence_claims_assumed,
    evidence_claims_disputed: input.evidence_claims_disputed,
    evidence_contradicted_claims: input.evidence_contradicted_claims,
    evidence_claims_needing_review: input.evidence_claims_needing_review,
    provenance_sources_total: input.provenance_sources_total,
    provenance_source_keys: [...(input.provenance_source_keys ?? [])].sort(),
    provenance_records_failed: input.provenance_records_failed,
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}
