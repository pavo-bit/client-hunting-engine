// Deterministic opportunity scoring, model score_v1 (T-011). Pure functions.
// Unit = one hypothesis. Weights below are PROVISIONAL (D-006 open); every
// number below carries its inputs so a reviewer can recompute by hand.
// Anti-double-counting design: each stored fact feeds exactly one dimension
// (identity completeness -> fit; claim assessments -> evidence; hypothesis
// structure -> opportunity; proposal fields -> feasibility; recency ->
// timing; risks -> deductions only).

export const SCORE_MODEL_VERSION = "score_v1" as const;

/** Default provisional weights. Override only via recorded D-* decisions. */
export interface ScoreWeights {
  fit: number;
  evidence: number;
  opportunity: number;
  feasibility: number;
  timing: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  fit: 30,
  evidence: 25,
  opportunity: 20,
  feasibility: 15,
  timing: 10,
};

export interface ScoreInputs {
  hasDomain: boolean;
  hasRegistry: boolean;
  hasCountry: boolean;
  hasCountryCode: boolean;
  hasAgencyType: boolean;
  corroboratedClaims: number;
  independentOrigins: number;
  freshSupporting: boolean;
  staleSupporting: boolean;
  hasRule: boolean;
  hasQuestions: boolean;
  hasRationale: boolean;
  contradictCount: number;
  hasProposal: boolean;
  proposalFeasibility: string | null;
  approvedCapability: boolean;
  unapprovedCapability: boolean;
  freshestEvidenceDays: number | null;
}

export interface DimensionResult {
  points: number;
  max: number;
  missing: boolean;
  rationale: string;
}

export interface ScoreBreakdown {
  fit: DimensionResult;
  evidence: DimensionResult;
  opportunity: DimensionResult;
  feasibility: DimensionResult;
  timing: DimensionResult;
  deductions: { points: number; reasons: string[] };
  total: number;
  band: "A" | "B" | "C" | "D";
  partial: boolean;
  missing: string[];
}

export function bandFor(total: number): "A" | "B" | "C" | "D" {
  if (total >= 75) return "A";
  if (total >= 55) return "B";
  if (total >= 35) return "C";
  return "D";
}

/**
 * Deterministic scoring. Identical inputs + weights = identical outputs.
 * Missing inputs contribute 0 AND are listed (never mistaken for low).
 */
export function scoreOpportunity(
  inputs: ScoreInputs,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): ScoreBreakdown {
  const missing: string[] = [];

  // Fit (identity completeness proxy — NOT an ICP match; no ICP is defined).
  let fit = 0;
  const fitParts: string[] = [];
  if (inputs.hasDomain) {
    fit += 8;
    fitParts.push("domain +8");
  } else {
    missing.push("domain");
  }
  if (inputs.hasRegistry) {
    fit += 10;
    fitParts.push("registry +10");
  } else {
    missing.push("registry");
  }
  if (inputs.hasCountry) {
    fit += 7;
    fitParts.push("country +7");
  } else {
    missing.push("country");
  }
  if (inputs.hasAgencyType) {
    fit += 5;
    fitParts.push("agency_type +5");
  } else {
    missing.push("agency_type");
  }
  fit = Math.min(fit, weights.fit);

  // Evidence (assessments only — never raw counts twice).
  let evidence = 0;
  const evParts: string[] = [];
  if (inputs.corroboratedClaims > 0) {
    evidence += 10;
    evParts.push(`corroborated claims ${inputs.corroboratedClaims} +10`);
  } else {
    missing.push("corroborated_claims");
  }
  if (inputs.independentOrigins >= 2) {
    evidence += 8;
    evParts.push(`independent origins ${inputs.independentOrigins} +8`);
  } else {
    missing.push("independent_origins>=2");
  }
  if (inputs.freshSupporting) {
    evidence += 7;
    evParts.push("fresh supporting evidence +7");
  } else {
    missing.push("fresh_support");
  }
  evidence = Math.min(evidence, weights.evidence);

  // Opportunity (hypothesis structure only — no evidence reuse).
  let opportunity = 0;
  const opParts: string[] = [];
  if (inputs.hasRule) {
    opportunity += 8;
    opParts.push("deterministic rule +8");
  } else {
    missing.push("rule");
  }
  if (inputs.hasQuestions) {
    opportunity += 6;
    opParts.push("validation questions +6");
  } else {
    missing.push("validation_questions");
  }
  if (inputs.hasRationale) {
    opportunity += 6;
    opParts.push("rationale +6");
  } else {
    missing.push("rationale");
  }
  opportunity = Math.min(opportunity, weights.opportunity);

  // Feasibility (proposal fields only; unapproved capabilities disclosed).
  let feasibility = 0;
  const feParts: string[] = [];
  if (!inputs.hasProposal) {
    missing.push("proposal");
  } else {
    feasibility += 8;
    feParts.push("scoped proposal +8");
    if (inputs.proposalFeasibility === "high") {
      feasibility += 4;
      feParts.push("feasibility high +4");
    } else if (inputs.proposalFeasibility === "medium") {
      feasibility += 2;
      feParts.push("feasibility medium +2");
    } else {
      missing.push("strong_feasibility");
    }
    if (inputs.approvedCapability) {
      feasibility += 3;
      feParts.push("approved capability +3");
    } else if (inputs.unapprovedCapability) {
      feParts.push("capability unapproved +0 (listed, never presented as approved)");
    } else {
      missing.push("capability_link");
    }
  }
  feasibility = Math.min(feasibility, weights.feasibility);

  // Timing (recency only).
  let timing = 0;
  const tiParts: string[] = [];
  if (inputs.freshestEvidenceDays === null) {
    missing.push("evidence_recency");
  } else if (inputs.freshestEvidenceDays <= 30) {
    timing = 10;
    tiParts.push(`freshest evidence ${inputs.freshestEvidenceDays}d +10`);
  } else if (inputs.freshestEvidenceDays <= 90) {
    timing = 6;
    tiParts.push(`freshest evidence ${inputs.freshestEvidenceDays}d +6`);
  } else {
    timing = 2;
    tiParts.push(`freshest evidence ${inputs.freshestEvidenceDays}d +2`);
  }
  timing = Math.min(timing, weights.timing);

  // Deductions (risks live ONLY here — never double-counted above).
  const reasons: string[] = [];
  let deductions = 0;
  if (inputs.contradictCount > 0) {
    deductions += 5;
    reasons.push(`${inputs.contradictCount} contradicting item(s) −5`);
  }
  if (inputs.staleSupporting) {
    deductions += 5;
    reasons.push("stale supporting evidence −5");
  }

  const total = Math.max(
    0,
    fit + evidence + opportunity + feasibility + timing - deductions,
  );
  return {
    fit: { points: fit, max: weights.fit, missing: missing.includes("domain") || missing.includes("registry"), rationale: fitParts.join("; ") || "no identity completeness" },
    evidence: { points: evidence, max: weights.evidence, missing: !inputs.freshSupporting, rationale: evParts.join("; ") || "no qualifying evidence" },
    opportunity: { points: opportunity, max: weights.opportunity, missing: !inputs.hasRule, rationale: opParts.join("; ") || "unstructured" },
    feasibility: { points: feasibility, max: weights.feasibility, missing: !inputs.hasProposal, rationale: feParts.join("; ") || "no proposal" },
    timing: { points: timing, max: weights.timing, missing: inputs.freshestEvidenceDays === null, rationale: tiParts.join("; ") || "no recency signal" },
    deductions: { points: deductions, reasons },
    total,
    band: bandFor(total),
    partial: missing.length > 0,
    missing,
  };
}
