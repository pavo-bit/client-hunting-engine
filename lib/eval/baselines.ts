// Baseline rankers for comparative evaluation (Part 3, §9).
//
// Three simple, explicit strategies plus the proposed multi-dimensional one.
// All rank the SAME eligible candidate pool from the SAME inputs, so the
// comparison is fair: identical pools, identical labels, documented
// exclusions. None of these is presented as a contender — they exist to show
// what the evidence-aware ranking adds (or fails to add) over the obvious.
//
//   fit_only    — service_fit desc, then need_strength;
//   recency_only— strongest timing signal desc (most recent need evidence);
//   rules_based — eligible + evidence count desc, then grade average;
//                 (the "what a careful analyst would sort by" rule);
//   multidim    — the proposed composite desc (lexicographic policy order).
//
// Pure functions over light inputs (no DB, no clock).

export interface BaselineCandidate {
  opportunityId: string;
  eligible: boolean;
  serviceFit: number | null;
  needStrength: number | null;
  timing: number | null;
  evidenceConfidence: number | null;
  composite: number | null;
  usableCount: number;
  gradeAverage: number | null;
  independentGroups: number;
  freshestAgeDays: number | null;
}

export type BaselineName = "fit_only" | "recency_only" | "rules_based" | "multidim";

function byId(a: string, b: string): number {
  return a.localeCompare(b);
}

function eligiblePool(cands: BaselineCandidate[]): BaselineCandidate[] {
  return cands.filter((c) => c.eligible && c.composite !== null);
}

export function rankFitOnly(cands: BaselineCandidate[]): string[] {
  return [...eligiblePool(cands)]
    .sort(
      (a, b) =>
        (b.serviceFit ?? -1) - (a.serviceFit ?? -1) ||
        (b.needStrength ?? -1) - (a.needStrength ?? -1) ||
        byId(a.opportunityId, b.opportunityId),
    )
    .map((c) => c.opportunityId);
}

export function rankRecencyOnly(cands: BaselineCandidate[]): string[] {
  return [...eligiblePool(cands)]
    .sort(
      (a, b) =>
        (b.timing ?? -1) - (a.timing ?? -1) ||
        (a.freshestAgeDays ?? Infinity) - (b.freshestAgeDays ?? Infinity) ||
        byId(a.opportunityId, b.opportunityId),
    )
    .map((c) => c.opportunityId);
}

export function rankRulesBased(cands: BaselineCandidate[]): string[] {
  return [...eligiblePool(cands)]
    .sort(
      (a, b) =>
        b.usableCount - a.usableCount ||
        (b.gradeAverage ?? -1) - (a.gradeAverage ?? -1) ||
        byId(a.opportunityId, b.opportunityId),
    )
    .map((c) => c.opportunityId);
}

export function rankMultidim(cands: BaselineCandidate[]): string[] {
  return [...eligiblePool(cands)]
    .sort((a, b) => (b.composite as number) - (a.composite as number) || byId(a.opportunityId, b.opportunityId))
    .map((c) => c.opportunityId);
}

export const BASELINES: Record<BaselineName, (cands: BaselineCandidate[]) => string[]> = {
  fit_only: rankFitOnly,
  recency_only: rankRecencyOnly,
  rules_based: rankRulesBased,
  multidim: rankMultidim,
};
