// Proposal lifecycle (T-009). Explicit operator actions only: nothing here
// creates, prices, or delivers on its own. Estimates come from the
// versioned rules model; prices/timelines are operator inputs with
// assumptions, or absent. All transitions audited with rationale.

import type { Pool } from "pg";
import {
  ESTIMATION_VERSION,
  estimateEffort,
  type EstimateInput,
  type EstimateItem,
} from "./estimate";

export const PROPOSAL_STATUSES = [
  "draft",
  "in_review",
  "needs_info",
  "accepted",
  "rejected",
  "superseded",
  "archived",
] as const;

const ELIGIBLE_HYPOTHESIS = ["validated"] as const;

const TRANSITIONS: Record<string, string[]> = {
  draft: ["in_review", "archived"],
  in_review: ["needs_info", "accepted", "rejected", "archived"],
  needs_info: ["in_review", "archived"],
  accepted: ["archived"],
  rejected: ["archived"],
  superseded: [],
  archived: [],
};

export interface IntakeError {
  status: number;
  code: string;
  message: string;
}

const fail = (status: number, code: string, message: string): IntakeError => ({
  status,
  code,
  message,
});

export interface ProposalInput {
  hypothesisId: string;
  title: string;
  scopeIn?: string;
  scopeOut?: string;
  milestones?: string;
  feasibility: "high" | "medium" | "low" | "unknown";
  capabilityFit?: string;
  assumptions: string;
  impactNote?: string;
  dependencies?: string;
  validationQuestions?: string;
  capabilityKeys?: string[];
  items?: EstimateItem[];
  contingencyPct?: number;
  unknowns?: string[];
  costLow?: number | null;
  costHigh?: number | null;
  costCurrency?: string | null;
  pricingModel?: "fixed_scope" | "time_and_materials" | "not_defined" | null;
  taxNote?: string | null;
  timelineLoWeeks?: number | null;
  timelineHiWeeks?: number | null;
  actor: string;
}

function checkContent(input: ProposalInput): void {
  const errs: string[] = [];
  const title = (input.title ?? "").trim();
  if (title.length === 0 || title.length > 300) errs.push("title must be 1..300 characters");
  if (!["high", "medium", "low", "unknown"].includes(input.feasibility))
    errs.push("feasibility must be high, medium, low, or unknown");
  if ((input.assumptions ?? "").trim().length === 0)
    errs.push("assumptions are required (ranges without stated assumptions are forbidden)");
  else if (input.assumptions!.length > 4000) errs.push("assumptions exceed 4000 characters");
  const { costLow, costHigh, costCurrency } = input;
  const costSet = costLow != null || costHigh != null || costCurrency != null;
  if (costSet) {
    if (costLow == null || costHigh == null || costCurrency == null)
      errs.push("cost needs low, high, AND currency together — no half estimates");
    else {
      if (!(costLow >= 0) || !(costHigh >= 0)) errs.push("cost bounds must be non-negative numbers");
      if (costLow > costHigh) errs.push("cost low must not exceed cost high");
      if (!/^[A-Z]{3}$/.test(costCurrency)) errs.push("currency must be 3 uppercase letters (no conversion is ever applied)");
    }
  }
  if (input.pricingModel != null && !["fixed_scope", "time_and_materials", "not_defined"].includes(input.pricingModel))
    errs.push("pricing_model must be fixed_scope, time_and_materials, or not_defined");
  const { timelineLoWeeks, timelineHiWeeks } = input;
  if (timelineLoWeeks != null || timelineHiWeeks != null) {
    if (!Number.isInteger(timelineLoWeeks) || !Number.isInteger(timelineHiWeeks))
      errs.push("timeline bounds must both be integers in weeks");
    else if ((timelineLoWeeks as number) < 0 || (timelineHiWeeks as number) < 0)
      errs.push("timeline bounds must be non-negative");
    else if ((timelineLoWeeks as number) > (timelineHiWeeks as number))
      errs.push("timeline low must not exceed timeline high");
  }
  if (errs.length > 0) throw fail(422, "bad_proposal", errs.join("; "));
}

function estimateOrNull(input: ProposalInput): {
  lo: number | null;
  hi: number | null;
  inputsJson: string | null;
  confidence: string | null;
  lines: string[];
  insufficient: boolean;
} {
  if (!input.items || input.items.length === 0) {
    return { lo: null, hi: null, inputsJson: null, confidence: null, lines: [], insufficient: true };
  }
  const res = estimateEffort({
    items: input.items,
    contingencyPct: input.contingencyPct ?? 15,
    assumptions: [input.assumptions],
    unknowns: input.unknowns ?? [],
  });
  if (res.outcome === "insufficient_information") {
    throw fail(422, "bad_estimate", res.reasons.join("; "));
  }
  return {
    lo: res.effortLoDays,
    hi: res.effortHiDays,
    inputsJson: JSON.stringify({
      version: ESTIMATION_VERSION,
      items: input.items,
      contingencyPct: input.contingencyPct ?? 15,
      unknowns: input.unknowns ?? [],
      lines: res.lines,
    }),
    confidence: res.confidence,
    lines: res.lines,
    insufficient: false,
  };
}

async function linkCapabilities(
  client: { query: (t: string, p: unknown[]) => Promise<{ rows: { key: string }[] }> },
  optionId: string,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;
  const found = await client.query("select key from public.capability where key = any($1)", [keys]);
  const have = new Set(found.rows.map((r) => r.key));
  const missing = keys.filter((k) => !have.has(k));
  if (missing.length > 0)
    throw fail(422, "bad_capability", `unknown capability keys: ${missing.join(", ")}`);
  for (const k of keys) {
    await client.query(
      "insert into public.project_capability (project_option_id, capability_key) values ($1, $2) on conflict do nothing",
      [optionId, k],
    );
  }
}

/** Explicit proposal creation from an eligible (validated) hypothesis. */
export async function createProposal(
  pool: Pool,
  input: ProposalInput,
): Promise<{ id: string; version: number }> {
  checkContent(input);
  const est = estimateOrNull(input);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const h = await client.query(
      "select id, status from public.hypothesis where id = $1 for update",
      [input.hypothesisId],
    );
    if (h.rows.length === 0) {
      await client.query("rollback");
      throw fail(404, "hypothesis_not_found", "hypothesis not found");
    }
    if (!(ELIGIBLE_HYPOTHESIS as readonly string[]).includes(h.rows[0].status as string)) {
      await client.query("rollback");
      throw fail(
        409,
        "hypothesis_not_eligible",
        `proposals require a validated hypothesis (current: ${h.rows[0].status}); human review first`,
      );
    }
    let optionId: string;
    try {
      const r = await client.query(
        `insert into public.project_option
           (hypothesis_id, title, scope_in, scope_out, milestones, effort_lo_days,
            effort_hi_days, feasibility, capability_fit, assumptions, impact_note,
            dependencies, validation_questions, cost_low, cost_high, cost_currency,
            pricing_model, tax_note, confidence, timeline_lo_weeks, timeline_hi_weeks,
            estimate_inputs, estimation_version, created_by, status, version)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'draft',1)
         returning id`,
        [
          input.hypothesisId,
          input.title.trim(),
          input.scopeIn ?? null,
          input.scopeOut ?? null,
          input.milestones ?? null,
          est.lo,
          est.hi,
          input.feasibility,
          input.capabilityFit ?? null,
          input.assumptions.trim(),
          input.impactNote ?? null,
          input.dependencies ?? null,
          input.validationQuestions ?? null,
          input.costLow ?? null,
          input.costHigh ?? null,
          input.costCurrency ?? null,
          input.pricingModel ?? null,
          input.taxNote ?? null,
          est.confidence,
          input.timelineLoWeeks ?? null,
          input.timelineHiWeeks ?? null,
          est.inputsJson,
          est.insufficient ? null : ESTIMATION_VERSION,
          input.actor,
        ],
      );
      optionId = r.rows[0].id as string;
    } catch (e: unknown) {
      await client.query("rollback");
      if ((e as { code?: string }).code === "23505")
        throw fail(409, "draft_exists", "a draft already exists for this hypothesis");
      throw e;
    }
    try {
      await linkCapabilities(client, optionId, input.capabilityKeys ?? []);
    } catch (e: unknown) {
      await client.query("rollback");
      throw e;
    }
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('project_option', $1, $2, null, 'draft', $3)`,
      [optionId, input.actor, `proposal drafted from hypothesis ${input.hypothesisId}`],
    );
    await client.query("commit");
    return { id: optionId, version: 1 };
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {
      /* already rolled back */
    }
    throw e;
  } finally {
    client.release();
  }
}

/** New version superseding the previous (history immutable, never rewritten). */
export async function createVersion(
  pool: Pool,
  optionId: string,
  actor: string,
  changes: Partial<ProposalInput>,
): Promise<{ id: string; version: number }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const cur = await client.query(
      "select * from public.project_option where id = $1 for update",
      [optionId],
    );
    if (cur.rows.length === 0) {
      await client.query("rollback");
      throw fail(404, "proposal_not_found", "proposal not found");
    }
    const p = cur.rows[0];
    if (p.status === "superseded" || p.status === "archived") {
      await client.query("rollback");
      throw fail(409, "version_closed", `cannot version a ${p.status} proposal`);
    }
    const merged: ProposalInput = {
      hypothesisId: p.hypothesis_id as string,
      title: changes.title ?? (p.title as string),
      scopeIn: changes.scopeIn ?? p.scope_in,
      scopeOut: changes.scopeOut ?? p.scope_out,
      milestones: changes.milestones ?? p.milestones,
      feasibility: (changes.feasibility ?? p.feasibility) as ProposalInput["feasibility"],
      capabilityFit: changes.capabilityFit ?? p.capability_fit,
      assumptions: changes.assumptions ?? (p.assumptions as string),
      impactNote: changes.impactNote ?? p.impact_note,
      dependencies: changes.dependencies ?? p.dependencies,
      validationQuestions: changes.validationQuestions ?? p.validation_questions,
      capabilityKeys: changes.capabilityKeys,
      costLow: changes.costLow ?? p.cost_low,
      costHigh: changes.costHigh ?? p.cost_high,
      costCurrency: changes.costCurrency ?? p.cost_currency,
      pricingModel: (changes.pricingModel ?? p.pricing_model) as ProposalInput["pricingModel"],
      taxNote: changes.taxNote ?? p.tax_note,
      timelineLoWeeks: changes.timelineLoWeeks ?? p.timeline_lo_weeks,
      timelineHiWeeks: changes.timelineHiWeeks ?? p.timeline_hi_weeks,
      actor,
    };
    checkContent(merged);
    // Re-estimate only when estimate-affecting inputs change; otherwise carry over.
    const prevInputs = p.estimate_inputs as { items?: unknown[] } | null;
    const itemsChanged =
      changes.items !== undefined ||
      changes.contingencyPct !== undefined ||
      changes.unknowns !== undefined;
    let est: ReturnType<typeof estimateOrNull>;
    if (itemsChanged) {
      est = estimateOrNull({
        ...merged,
        items: changes.items,
        contingencyPct: changes.contingencyPct,
        unknowns: changes.unknowns,
      });
    } else {
      est = {
        lo: p.effort_lo_days as number | null,
        hi: p.effort_hi_days as number | null,
        inputsJson: prevInputs ? JSON.stringify(prevInputs) : null,
        confidence: p.confidence as string | null,
        lines: [],
        insufficient: p.effort_lo_days == null,
      };
    }
    // Supersede FIRST: the one-draft-per-hypothesis unique index would
    // otherwise collide with the incoming draft row in the same transaction.
    await client.query("update public.project_option set status = 'superseded' where id = $1", [
      optionId,
    ]);
    let nextId: string;
    try {
      const r = await client.query(
        `insert into public.project_option
           (hypothesis_id, title, scope_in, scope_out, milestones, effort_lo_days,
            effort_hi_days, feasibility, capability_fit, assumptions, impact_note,
            dependencies, validation_questions, cost_low, cost_high, cost_currency,
            pricing_model, tax_note, confidence, timeline_lo_weeks, timeline_hi_weeks,
            estimate_inputs, estimation_version, created_by, status, version)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'draft',$25)
         returning id`,
        [
          p.hypothesis_id,
          merged.title.trim(),
          merged.scopeIn ?? null,
          merged.scopeOut ?? null,
          merged.milestones ?? null,
          est.lo,
          est.hi,
          merged.feasibility,
          merged.capabilityFit ?? null,
          merged.assumptions.trim(),
          merged.impactNote ?? null,
          merged.dependencies ?? null,
          merged.validationQuestions ?? null,
          merged.costLow ?? null,
          merged.costHigh ?? null,
          merged.costCurrency ?? null,
          merged.pricingModel ?? null,
          merged.taxNote ?? null,
          est.confidence,
          merged.timelineLoWeeks ?? null,
          merged.timelineHiWeeks ?? null,
          est.inputsJson,
          est.insufficient ? null : ESTIMATION_VERSION,
          actor,
          (p.version as number) + 1,
        ],
      );
      nextId = r.rows[0].id as string;
    } catch (e: unknown) {
      await client.query("rollback");
      if ((e as { code?: string }).code === "23505")
        throw fail(409, "version_race", "a newer version already exists; reload and retry");
      throw e;
    }
    // Carry capabilities forward unless explicitly replaced.
    if (changes.capabilityKeys !== undefined) {
      await linkCapabilities(client, nextId, changes.capabilityKeys);
    } else {
      const caps = await client.query(
        "select capability_key from public.project_capability where project_option_id = $1",
        [optionId],
      );
      for (const row of caps.rows) {
        await client.query(
          "insert into public.project_capability (project_option_id, capability_key) values ($1, $2) on conflict do nothing",
          [nextId, row.capability_key],
        );
      }
    }
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('project_option', $1, $2, $3, 'superseded', $4),
              ('project_option', $5, $2, null, 'draft', $6)`,
      [optionId, actor, p.status as string, `replaced by version ${(p.version as number) + 1}`, nextId, "new version drafted"],
    );
    await client.query("commit");
    return { id: nextId, version: (p.version as number) + 1 };
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {
      /* already rolled back */
    }
    throw e;
  } finally {
    client.release();
  }
}

/** Review decision with rationale (audited). Terminal states stay decided. */
export async function decideProposal(
  pool: Pool,
  id: string,
  input: { decision: string; reason: string; actor: string },
): Promise<{ id: string; status: string }> {
  const map: Record<string, string> = {
    submit: "in_review",
    request_info: "needs_info",
    accept: "accepted",
    reject: "rejected",
    archive: "archived",
  };
  if (!Object.keys(map).includes(input.decision))
    throw fail(422, "bad_decision", `decision must be one of: ${Object.keys(map).join(", ")}`);
  if (!(input.reason ?? "").trim())
    throw fail(422, "reason_required", "a rationale is required for every decision");
  const to = map[input.decision];
  const client = await pool.connect();
  try {
    await client.query("begin");
    const cur = await client.query(
      "select id, status from public.project_option where id = $1 for update",
      [id],
    );
    if (cur.rows.length === 0) {
      await client.query("rollback");
      throw fail(404, "proposal_not_found", "proposal not found");
    }
    const from: string = cur.rows[0].status;
    if (!(TRANSITIONS[from] ?? []).includes(to)) {
      await client.query("rollback");
      throw fail(409, "bad_transition", `cannot move proposal from ${from} to ${to}`);
    }
    await client.query(
      `update public.project_option set status = $2, decided_by = $3, decided_at = now(),
         decision_rationale = $4 where id = $1`,
      [id, to, input.actor, input.reason.trim()],
    );
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('project_option', $1, $2, $3, $4, $5)`,
      [id, input.actor, from, to, `${input.decision}: ${input.reason.trim()}`],
    );
    await client.query("commit");
    return { id, status: to };
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {
      /* already rolled back */
    }
    throw e;
  } finally {
    client.release();
  }
}

export interface ProposalDetail {
  proposal: Record<string, unknown>;
  versions: { id: string; version: number; status: string; created_at: string }[];
  stale: boolean;
  staleReasons: string[];
}

/** Proposal detail + version chain + material-change freshness flag. */
export async function getProposalDetail(pool: Pool, id: string): Promise<ProposalDetail | null> {
  const client = await pool.connect();
  try {
    const p = await client.query("select * from public.project_option where id = $1", [id]);
    if (p.rows.length === 0) return null;
    const row = p.rows[0];
    const versions = (
      await client.query(
        `select id, version, status, created_at from public.project_option
         where hypothesis_id = $1 order by version`,
        [row.hypothesis_id],
      )
    ).rows as ProposalDetail["versions"];
    // Freshness: evidence linked/assessed or claims created after this version.
    const staleReasons: string[] = [];
    const hyp = await client.query(
      "select status from public.hypothesis where id = $1",
      [row.hypothesis_id],
    );
    if (hyp.rows.length > 0 && ["rejected", "superseded"].includes(hyp.rows[0].status)) {
      staleReasons.push(
        `underlying hypothesis is ${hyp.rows[0].status} — revalidate before pursuing`,
      );
    }
    const ev = await client.query(
      "select max(created_at) as m from public.hypothesis_evidence where hypothesis_id = $1",
      [row.hypothesis_id],
    );
    if (ev.rows[0].m && new Date(ev.rows[0].m as string) > new Date(row.created_at as string))
      staleReasons.push("new evidence linked after this version was drafted");
    const au = await client.query(
      `select max(a.created_at) as m from public.audit_log a
       join public.hypothesis_evidence he on he.claim_id::text = a.entity_id
       where a.entity_type = 'claim' and he.hypothesis_id = $1`,
      [row.hypothesis_id],
    );
    if (au.rows[0].m && new Date(au.rows[0].m as string) > new Date(row.created_at as string))
      staleReasons.push("claim assessments changed after this version was drafted");
    return { proposal: row as Record<string, unknown>, versions, stale: staleReasons.length > 0, staleReasons };
  } finally {
    client.release();
  }
}
