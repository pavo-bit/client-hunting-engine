// Deterministic lead-quality scoring (Part 2, §7). Pure functions only.
//
// `score(...)` is pure: no network, no clock reads (as_of is an explicit
// input), no randomness, no state. Identical versioned inputs + identical
// as_of produce byte-identical outputs (tested by replay).
//
// Concepts kept apart on purpose:
//   gates (eligible?)       — lib/qualification/gates.ts, evaluated first;
//   dimensions (how good?)  — here, each with rubric, range, missing semantics;
//   composite (rankable?)   — weighted scored dimensions only, with coverage;
//   pursuit (act now?)      — composite + capacity alignment (order only);
//   bands                   — policy-defined labels, or null when the policy
//                             permits no bands.
// Scores are ORDINAL ranks within one policy version, never probabilities and
// never conversion estimates. Missing data is never favourable: an unscorable
// dimension is null (not zero, not imputed), excluded from the composite, and
// counted against weight coverage — which can veto the composite entirely.

import { createHash } from "crypto";
import type { EvidenceBundle, EvidenceItem } from "./evidence.ts";
import { evaluateGates, type GateContext, type QualificationOutcome } from "./gates.ts";
import {
  DIMENSIONS,
  INTRINSIC_DIMENSIONS,
  type CapacityDefinition,
  type Dimension,
  type PolicyDefinition,
  type RubricDimension,
  type ServiceDefinition,
} from "./policy.ts";
import type { QualificationRow } from "./view.ts";

/** Engine code version recorded with every assessment for reproducibility. */
export const ENGINE_VERSION = "part2-1";

export interface OperatorAnswers {
  contactChannelKnown?: boolean;
  timelineMonths?: number | null;
  budgetIndication?: "yes" | "no" | null;
}

export interface DimensionScore {
  score: number | null;
  explanation: string;
  evidenceRefs: string[];
  missing: string[];
  flags: string[];
}

export interface ScoreInput {
  row: QualificationRow;
  bundle: EvidenceBundle;
  policy: PolicyDefinition;
  policyVersion: string;
  services: ServiceDefinition[];
  catalogVersion: string;
  rubric: Record<Dimension, RubricDimension>;
  rubricVersion: string;
  capacity: { version: string; definition: CapacityDefinition } | null;
  operatorAnswers?: OperatorAnswers;
  asOf: string;
  relationships?: { relType: string }[];
  requiredUsable?: number;
  negativeFindings?: { findingId: string; question: string }[];
}

export interface ScoreResult {
  outcome: QualificationOutcome;
  gateReasonCodes: (string | null)[];
  primaryGate: string | null;
  dimensions: Record<Dimension, DimensionScore>;
  composite: number | null;
  weightCoverage: number;
  floorsMet: Record<string, boolean>;
  band: string | null;
  missingData: { dimension: string; missing: string[] }[];
  contradictions: { claimId: string; text: string }[];
  negativeEvidence: { findingId: string; question: string }[];
  reasonCodes: string[];
  flags: string[];
  versions: { policy: string; catalog: string; rubric: string; capacity: string | null };
  snapshotHash: string;
  bundleHash: string;
  asOf: string;
  engineVersion: string;
  inputHash: string;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Decay 100 -> 20 linearly across [fresh, stale]; 10 beyond stale; 100 within fresh. */
export function decayScore(ageDays: number | null, freshDays: number, staleDays: number): number {
  if (ageDays === null || ageDays < 0) return 50; // undated: neutral, cited as missing recency
  if (ageDays <= freshDays) return 100;
  if (ageDays <= staleDays) {
    return Math.round(100 - ((ageDays - freshDays) / Math.max(1, staleDays - freshDays)) * 80);
  }
  return 10;
}

const GRADE_POINTS: Record<string, number> = { A: 100, B: 80, C: 50, D: 0 };

function needFamilies(service: ServiceDefinition): string[] {
  return service.signalFamilies;
}

/** Compatible services for this opportunity (same rule as the availability gate). */
export function compatibleServices(
  row: QualificationRow,
  services: ServiceDefinition[],
): ServiceDefinition[] {
  const pipeline = String(row.pipeline);
  const agencyType = row.company_agency_type === null ? null : String(row.company_agency_type);
  const country = row.company_country === null ? null : String(row.company_country);
  return services.filter(
    (s) =>
      (s.pipelines as string[]).includes(pipeline) &&
      (s.profiles.agencyTypes.length === 0 || (agencyType !== null && s.profiles.agencyTypes.includes(agencyType))) &&
      (s.profiles.countries === null || (country !== null && s.profiles.countries.includes(country))),
  );
}

function scoreServiceFit(
  row: QualificationRow,
  bundle: EvidenceBundle,
  services: ServiceDefinition[],
): DimensionScore {
  const compatible = compatibleServices(row, services);
  if (compatible.length === 0) {
    return { score: null, explanation: "no compatible approved service — unscorable", evidenceRefs: [], missing: ["compatible_service"], flags: ["NO_SERVICE"] };
  }
  // Best-fit service wins; ties keep the first service in service_id order,
  // so the choice is deterministic. (A 0-score anti-signal zeroing must still
  // be selectable, so the accumulator starts empty rather than at 0.)
  let best: DimensionScore | null = null;
  const consider = (candidate: DimensionScore): void => {
    if (best === null || (candidate.score ?? -1) > (best.score ?? -1)) best = candidate;
  };
  for (const service of [...compatible].sort((a, b) => a.serviceId.localeCompare(b.serviceId))) {
    const fams = needFamilies(service);
    const matched = fams.filter((f) => bundle.usable.some((i) => i.signalFamily === f));
    const coverage = fams.length === 0 ? 0 : matched.length / fams.length;
    const profile = 50; // compatible by construction (profile rule above)
    // Disqualifying anti-signals: an anti-signal id names a signal family;
    // usable evidence in that family zeroes the fit for THIS service with an
    // explicit flag (a dimension weakness, not a gate — the gate only checks
    // that some compatible service exists).
    const evidenceFamilies = new Set(
      bundle.usable.map((i) => i.signalFamily).filter((f): f is string => f !== null),
    );
    const antiHit = service.antiSignals.find((a) => a.disqualifying && evidenceFamilies.has(a.id));
    if (antiHit) {
      consider({
        score: 0,
        explanation: `${service.serviceId}: disqualifying anti-signal '${antiHit.id}' matched by evidence`,
        evidenceRefs: bundle.usable.filter((i) => i.signalFamily === antiHit.id).map((i) => i.claimId),
        missing: [],
        flags: ["ANTI_SIGNAL_HIT"],
      });
      continue;
    }
    consider({
      score: Math.round(profile + 50 * coverage),
      explanation: `${service.serviceId}: profile match 50 + family coverage ${matched.length}/${fams.length} (${matched.join(", ") || "none"})`,
      evidenceRefs: bundle.usable.filter((i) => i.signalFamily !== null && fams.includes(i.signalFamily as string)).map((i) => i.claimId),
      missing: matched.length < fams.length ? [`signal families without evidence: ${fams.filter((f) => !matched.includes(f)).join(", ")}`] : [],
      flags: [],
    });
  }
  if (bundle.usable.length === 0) {
    return { score: null, explanation: "no usable evidence — fit unscorable", evidenceRefs: [], missing: ["usable_evidence"], flags: ["NO_INPUT"] };
  }
  return best ?? { score: null, explanation: "no compatible approved service — unscorable", evidenceRefs: [], missing: ["compatible_service"], flags: ["NO_SERVICE"] };
}

function scoreNeedStrength(bundle: EvidenceBundle, service: ServiceDefinition | null): DimensionScore {
  const fams = service ? needFamilies(service) : [];
  const need = bundle.usable.filter((i) => i.signalFamily !== null && (fams.length === 0 || fams.includes(i.signalFamily as string)));
  if (need.length === 0) {
    return { score: null, explanation: "no usable need-family evidence", evidenceRefs: [], missing: ["need_family_evidence"], flags: ["NO_INPUT"] };
  }
  const groups = new Set(need.map((i) => i.independenceGroup)).size;
  const supporting = need.filter((i) => i.polarity === "supports").length;
  const gradeAvg = need.reduce((a, i) => a + (GRADE_POINTS[i.trustGrade] ?? 0), 0) / need.length;
  const score = clamp(Math.round(25 * groups + 10 * supporting + gradeAvg * 0.25), 0, 100);
  return {
    score,
    explanation: `${groups} independent group(s), ${supporting} supporting, grade average ${Math.round(gradeAvg)}`,
    evidenceRefs: need.map((i) => i.claimId),
    missing: groups < 2 ? ["second independent source"] : [],
    flags: need.some((i) => i.lowConfidence) ? ["LOW_CONFIDENCE_SOURCE"] : [],
  };
}

function scoreTiming(
  bundle: EvidenceBundle,
  timing: PolicyDefinition["timing"],
  freshnessDefaultDays: number,
): DimensionScore {
  const dated = bundle.usable.filter((i) => i.ageDays !== null);
  if (dated.length === 0) {
    return { score: null, explanation: "no dated usable evidence — recency unscorable", evidenceRefs: [], missing: ["recency"], flags: ["NO_INPUT"] };
  }
  let best: EvidenceItem | null = null;
  let bestScore = -1;
  for (const item of dated) {
    const rule = (item.signalFamily && timing[item.signalFamily]) || { freshDays: freshnessDefaultDays, staleDays: freshnessDefaultDays * 3 };
    const s = decayScore(item.ageDays, rule.freshDays, rule.staleDays);
    if (s > bestScore) {
      bestScore = s;
      best = item;
    }
  }
  return {
    score: bestScore,
    explanation: `strongest timely signal ${best!.claimId}: age ${best!.ageDays}d scores ${bestScore} (family ${best!.signalFamily ?? "unmapped"})`,
    evidenceRefs: [best!.claimId],
    missing: bestScore < 100 ? ["fresher need signal"] : [],
    flags: best!.freshness === "stale" ? ["STALE_SIGNAL"] : [],
  };
}

function scoreEvidenceConfidence(bundle: EvidenceBundle): DimensionScore {
  if (bundle.usable.length === 0) {
    return { score: null, explanation: "no usable evidence — confidence unscorable", evidenceRefs: [], missing: ["usable_evidence"], flags: ["NO_INPUT"] };
  }
  const avg = bundle.usable.reduce((a, i) => a + (GRADE_POINTS[i.trustGrade] ?? 0), 0) / bundle.usable.length;
  const groups = new Set(bundle.usable.map((i) => i.independenceGroup)).size;
  const reviewPenalty = bundle.usable.some((i) => i.needsReview) ? 10 : 0;
  const score = clamp(Math.round(avg * 0.7 + Math.min(30, groups * 15) - reviewPenalty), 0, 100);
  return {
    score,
    explanation: `grade average ${Math.round(avg)}, ${groups} independent group(s)${reviewPenalty ? ", needs-review penalty 10" : ""}`,
    evidenceRefs: bundle.usable.map((i) => i.claimId),
    missing: groups < 2 ? ["independent corroboration"] : [],
    flags: [
      ...(bundle.usable.some((i) => i.lowConfidence) ? ["LOW_CONFIDENCE_SOURCE"] : []),
      ...(reviewPenalty ? ["NEEDS_REVIEW"] : []),
    ],
  };
}

function scoreActionability(
  row: QualificationRow,
  answers: OperatorAnswers,
  bundle: EvidenceBundle,
): DimensionScore {
  const parts: string[] = [];
  const missing: string[] = [];
  let score = 0;
  const domain = row.company_domain_norm === null ? null : String(row.company_domain_norm);
  if (domain) {
    score += 40;
    parts.push("canonical domain present (+40)");
  } else {
    missing.push("contact domain");
  }
  if (answers.contactChannelKnown === true) {
    score += 30;
    parts.push("operator-confirmed channel (+30)");
  } else if (answers.contactChannelKnown === undefined) {
    missing.push("contact_channel_known (operator answer)");
  }
  if (typeof answers.timelineMonths === "number" && answers.timelineMonths >= 0) {
    score += answers.timelineMonths <= 6 ? 30 : 15;
    parts.push(`timeline ${answers.timelineMonths}mo (+${answers.timelineMonths <= 6 ? 30 : 15})`);
  } else {
    missing.push("timeline_months (operator answer)");
  }
  if (missing.length === 3) {
    return { score: null, explanation: "no channel information at all — actionability unscorable", evidenceRefs: [], missing, flags: ["NO_INPUT"] };
  }
  return { score, explanation: parts.join("; "), evidenceRefs: [], missing, flags: [] };
}

/**
 * Score one opportunity snapshot. Read the ScoreResult contract in §7 of the
 * task: every field there is populated here, deterministically.
 */
export function score(input: ScoreInput): ScoreResult {
  const asOf = new Date(input.asOf);
  if (Number.isNaN(asOf.getTime())) {
    const e = new Error("asOf must be an ISO timestamp") as Error & { status: number; code: string };
    e.status = 422;
    e.code = "bad_as_of";
    throw e;
  }
  const gateCtx: GateContext = {
    row: input.row,
    bundle: input.bundle,
    services: input.services,
    policy: input.policy,
  };
  const gates = evaluateGates(gateCtx, {
    relationships: input.relationships ?? [],
    requiredUsable: input.requiredUsable ?? 1,
  });
  const compatible = compatibleServices(input.row, input.services);
  const bestService = compatible[0] ?? null;

  const dimensions: Record<Dimension, DimensionScore> = {
    service_fit: scoreServiceFit(input.row, input.bundle, input.services),
    need_strength: scoreNeedStrength(input.bundle, bestService),
    timing: scoreTiming(input.bundle, input.policy.timing, input.policy.freshnessDefaultDays),
    evidence_confidence: scoreEvidenceConfidence(input.bundle),
    actionability: scoreActionability(input.row, input.operatorAnswers ?? {}, input.bundle),
    pursuit_priority: { score: null, explanation: "", evidenceRefs: [], missing: [], flags: [] },
  };

  // Composite over SCORED intrinsic dimensions only; coverage can veto.
  let scoredWeight = 0;
  let totalWeight = 0;
  let weighted = 0;
  for (const d of INTRINSIC_DIMENSIONS) {
    const w = input.policy.weights[d] ?? 0;
    totalWeight += w;
    const s = dimensions[d].score;
    if (s !== null) {
      scoredWeight += w;
      weighted += w * s;
    }
  }
  const weightCoverage = totalWeight > 0 ? scoredWeight / totalWeight : 0;
  const insufficientCoverage = weightCoverage < input.policy.minCoverage;
  const composite =
    !insufficientCoverage && scoredWeight > 0 ? Math.round((weighted / scoredWeight) * 10) / 10 : null;

  // Floors are checked here (reported) and enforced in ranking.
  const floorsMet: Record<string, boolean> = {};
  for (const d of DIMENSIONS) {
    const floor = input.policy.floors[d] ?? null;
    const s = dimensions[d].score;
    floorsMet[d] = floor === null ? true : s !== null && s >= floor;
  }

  // Pursuit priority: composite adjusted by capacity alignment ONLY.
  // Intrinsic dimensions are never touched by capacity (tested).
  let pursuit: number | null = null;
  const pursuitParts: string[] = [];
  if (composite !== null && input.capacity) {
    const cap = input.capacity.definition;
    let adj = 0;
    if (bestService && cap.focusServices.includes(bestService.serviceId)) {
      adj += 5;
      pursuitParts.push("focus service +5");
    }
    if (cap.focusPipelines.includes(String(input.row.pipeline))) {
      adj += 3;
      pursuitParts.push("focus pipeline +3");
    }
    pursuit = clamp(Math.round(composite + adj), 0, 100);
    pursuitParts.unshift(`composite ${composite}`);
  } else if (composite !== null) {
    pursuit = composite;
    pursuitParts.push(`composite ${composite} (no capacity profile — unadjusted)`);
  }
  dimensions.pursuit_priority = {
    score: pursuit,
    explanation: pursuit === null ? "no composite — pursuit unscorable" : pursuitParts.join("; "),
    evidenceRefs: [],
    missing: pursuit === null ? ["composite"] : [],
    flags: input.capacity ? ["CAPACITY_ADJUSTED"] : ["NO_CAPACITY"],
  };

  const band =
    composite !== null && input.policy.bands !== null
      ? (input.policy.bands.find((b) => composite >= b.min)?.name ?? null)
      : null;

  const missingData = (Object.keys(dimensions) as Dimension[])
    .filter((d) => dimensions[d].missing.length > 0)
    .map((d) => ({ dimension: d, missing: dimensions[d].missing }));
  const contradictions = input.bundle.items
    .filter((i) => i.polarity === "contradicts")
    .map((i) => ({ claimId: i.claimId, text: i.normalizedText.slice(0, 200) }));
  const reasonCodes = [
    ...(gates.primary?.reasonCode ? [gates.primary.reasonCode] : []),
    ...dimensions.service_fit.flags,
    ...dimensions.need_strength.flags,
    ...dimensions.evidence_confidence.flags,
  ];
  const flags = [
    ...(insufficientCoverage ? ["INSUFFICIENT_COVERAGE"] : []),
    ...(composite === null ? ["NO_COMPOSITE"] : []),
    ...(input.policy.bands === null ? ["BANDS_NOT_PERMITTED"] : []),
    ...(input.bundle.ambiguousEntity ? ["ENTITY_AMBIGUOUS"] : []),
  ];

  const snapshotHashSource = JSON.stringify({
    opportunity: input.row.opportunity_id,
    status: String(input.row.opportunity_status),
    bundle: input.bundle.bundleHash,
    versions: [input.policyVersion, input.catalogVersion, input.rubricVersion, input.capacity?.version ?? null],
    asOf: input.asOf,
  });
  const snapshotHash = createHash("sha256").update(snapshotHashSource, "utf8").digest("hex");
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        row: input.row,
        bundleHash: input.bundle.bundleHash,
        policy: input.policy,
        policyVersion: input.policyVersion,
        catalogVersion: input.catalogVersion,
        rubricVersion: input.rubricVersion,
        capacity: input.capacity,
        answers: input.operatorAnswers ?? {},
        asOf: input.asOf,
        engine: ENGINE_VERSION,
      }),
      "utf8",
    )
    .digest("hex");

  return {
    outcome: gates.outcome,
    gateReasonCodes: gates.evaluations.map((e) => e.reasonCode),
    primaryGate: gates.primary?.gate ?? null,
    dimensions,
    composite,
    weightCoverage: Math.round(weightCoverage * 1000) / 1000,
    floorsMet,
    band,
    missingData,
    contradictions,
    negativeEvidence: (input.negativeFindings ?? []).map((n) => ({ findingId: n.findingId, question: n.question })),
    reasonCodes,
    flags,
    versions: {
      policy: input.policyVersion,
      catalog: input.catalogVersion,
      rubric: input.rubricVersion,
      capacity: input.capacity?.version ?? null,
    },
    snapshotHash,
    bundleHash: input.bundle.bundleHash,
    asOf: input.asOf,
    engineVersion: ENGINE_VERSION,
    inputHash,
  };
}
