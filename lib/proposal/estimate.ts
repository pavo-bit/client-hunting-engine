// Deterministic estimation model, version 1 (T-009). Pure functions.
// Ranges only — never point estimates, never client budgets, revenue, ROI,
// or willingness-to-pay. Effort, timeline, price, and third-party costs are
// SEPARATE inputs; nothing is inferred from anything else without a
// documented rule (there is no such rule in v1: timeline and price are
// operator-provided with assumptions, or absent).

export const ESTIMATION_VERSION = "1" as const;

export type Complexity = "S" | "M" | "L" | "XL";
export type ItemKind =
  | "feature"
  | "integration"
  | "data_migration"
  | "security"
  | "testing";

export interface EstimateItem {
  name: string;
  complexity: Complexity;
  kind: ItemKind;
}

/** Person-day ranges per complexity for plain feature work (provisional
 *  baseline D-005-adjacent; Grayscales owner input still required). */
const FEATURE_DAYS: Record<Complexity, [number, number]> = {
  S: [2, 4],
  M: [5, 10],
  L: [12, 20],
  XL: [25, 40],
};

const KIND_MULTIPLIER: Record<ItemKind, number> = {
  feature: 1,
  integration: 1.5,
  data_migration: 1.3,
  security: 1,
  testing: 1, // testing effort is computed as 20% of the subtotal instead
};

const SECURITY_FLAT: [number, number] = [3, 5];
const TESTING_SHARE = 0.2;
const HANDOVER: [number, number] = [2, 3];

export interface EstimateInput {
  items: EstimateItem[];
  /** Contingency percent 0..100 applied to the summed range. */
  contingencyPct: number;
  /** Documented assumptions behind the items (required for an estimate). */
  assumptions: string[];
  /** Open unknowns that cap confidence. */
  unknowns?: string[];
}

export type EstimateOutcome =
  | {
      outcome: "estimated";
      effortLoDays: number;
      effortHiDays: number;
      lines: string[];
      confidence: "low" | "medium";
      contingencyPct: number;
    }
  | { outcome: "insufficient_information"; reasons: string[] };

const COMPLEXITIES: Complexity[] = ["S", "M", "L", "XL"];
const KINDS: ItemKind[] = ["feature", "integration", "data_migration", "security", "testing"];

export function validateEstimateInput(input: EstimateInput): string[] {
  const problems: string[] = [];
  if (!Array.isArray(input.items)) problems.push("items must be an array");
  for (const [i, it] of (input.items ?? []).entries()) {
    if (!it || typeof it.name !== "string" || it.name.trim() === "")
      problems.push(`item ${i}: name is required`);
    if (!COMPLEXITIES.includes(it?.complexity))
      problems.push(`item ${i}: complexity must be S, M, L, or XL`);
    if (!KINDS.includes(it?.kind))
      problems.push(`item ${i}: kind must be feature, integration, data_migration, security, or testing`);
  }
  if (
    typeof input.contingencyPct !== "number" ||
    !Number.isFinite(input.contingencyPct) ||
    input.contingencyPct < 0 ||
    input.contingencyPct > 100
  )
    problems.push("contingencyPct must be 0..100");
  if (!Array.isArray(input.assumptions) || input.assumptions.every((a) => a.trim() === ""))
    problems.push("at least one documented assumption is required");
  return problems;
}

export function estimateEffort(input: EstimateInput): EstimateOutcome {
  const problems = validateEstimateInput(input);
  if ((input.items ?? []).length === 0) {
    return {
      outcome: "insufficient_information",
      reasons: ["no line items provided — refusing to invent precision", ...problems],
    };
  }
  if (problems.length > 0) {
    return { outcome: "insufficient_information", reasons: problems };
  }
  const lines: string[] = [];
  let lo = 0;
  let hi = 0;
  let hasTesting = false;
  let hasSecurity = false;
  for (const it of input.items) {
    if (it.kind === "testing") {
      hasTesting = true;
      lines.push(`${it.name}: testing sized as 20% of subtotal (see below)`);
      continue;
    }
    const [blo, bhi] = FEATURE_DAYS[it.complexity];
    const m = KIND_MULTIPLIER[it.kind];
    const ilo = blo * m;
    const ihi = bhi * m;
    lo += ilo;
    hi += ihi;
    lines.push(
      `${it.name} [${it.kind}/${it.complexity}]: ${ilo.toFixed(1)}–${ihi.toFixed(1)} person-days (base ${blo}–${bhi} × ${m})`,
    );
    if (it.kind === "security") hasSecurity = true;
  }
  if (hasSecurity) {
    lo += SECURITY_FLAT[0];
    hi += SECURITY_FLAT[1];
    lines.push(`security baseline: +${SECURITY_FLAT[0]}–${SECURITY_FLAT[1]} person-days (reviews, hardening)`);
  }
  if (hasTesting) {
    const tlo = lo * TESTING_SHARE;
    const thi = hi * TESTING_SHARE;
    lo += tlo;
    hi += thi;
    lines.push(`testing: +20% of subtotal (${tlo.toFixed(1)}–${thi.toFixed(1)} person-days)`);
  }
  lo += HANDOVER[0];
  hi += HANDOVER[1];
  lines.push(`handover (docs, deployment, training): +${HANDOVER[0]}–${HANDOVER[1]} person-days`);
  const c = 1 + input.contingencyPct / 100;
  lines.push(`contingency: ×${c.toFixed(2)} (${input.contingencyPct}% — covers estimating uncertainty only)`);
  const effortLoDays = Math.ceil(lo * c);
  const effortHiDays = Math.ceil(hi * c);
  const unknowns = (input.unknowns ?? []).filter((u) => u.trim() !== "");
  const hasXL = input.items.some((it) => it.complexity === "XL");
  const confidence = unknowns.length > 0 || hasXL ? "low" : "medium";
  if (unknowns.length > 0)
    lines.push(`confidence capped at low by ${unknowns.length} open unknown(s)`);
  if (hasXL) lines.push("confidence capped at low: XL items carry the widest uncertainty");
  return { outcome: "estimated", effortLoDays, effortHiDays, lines, confidence, contingencyPct: input.contingencyPct };
}
