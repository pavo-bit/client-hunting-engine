// Hypothesis detail aggregate for review UI (T-008). Read-only.

import type { Pool } from "pg";
import { TAXONOMY } from "./taxonomy";

export interface HypothesisDetail {
  hypothesis: {
    id: string;
    company_id: string;
    company_name: string;
    title: string;
    opportunity_category: string;
    status: string;
    rule_id: string | null;
    rule_version: string | null;
    rationale: string | null;
    assumptions: string | null;
    alternatives: string | null;
    missing_info: string | null;
    validation_questions: string | null;
    intervention: string | null;
    decided_by: string | null;
    decided_at: string | null;
    decision_rationale: string | null;
    created_at: string;
  };
  taxonomy: {
    problem: string;
    insufficientAlone: string[];
    mustNotGenerate: string[];
  } | null;
  supporting: { claim_id: string; claim_text: string; status: string }[];
  contradicting: { claim_id: string; claim_text: string; status: string }[];
  decisions: {
    actor: string;
    transition_from: string | null;
    transition_to: string | null;
    reason: string | null;
    created_at: string;
  }[];
  latestScore: {
    total: number;
    band: string;
    partial: boolean;
    model_version: string;
    evaluated_at: string;
  } | null;
}

export async function getHypothesisDetail(
  pool: Pool,
  id: string,
): Promise<HypothesisDetail | null> {
  const client = await pool.connect();
  try {
    const h = await client.query(
      `select h.*, c.name as company_name
       from public.hypothesis h join public.company c on c.id = h.company_id
       where h.id = $1`,
      [id],
    );
    if (h.rows.length === 0) return null;
    const hyp = h.rows[0];
    const ev = await client.query(
      `select he.polarity, he.claim_id, cl.claim_text, cl.claim_status as status
       from public.hypothesis_evidence he
       join public.claim cl on cl.id = he.claim_id
       where he.hypothesis_id = $1 order by he.polarity, cl.created_at`,
      [id],
    );
    const decisions = await client.query(
      `select actor, transition_from, transition_to, reason, created_at
       from public.audit_log
       where entity_type = 'hypothesis' and entity_id = $1
       order by created_at`,
      [id],
    );
    const tax = TAXONOMY.find((t) => t.category === hyp.opportunity_category) ?? null;
    const sc = await client.query(
      `select total, band, partial, model_version, evaluated_at
       from public.score_run where hypothesis_id = $1 order by evaluated_at desc limit 1`,
      [id],
    );
    return {
      hypothesis: {
        id: hyp.id,
        company_id: hyp.company_id,
        company_name: hyp.company_name,
        title: hyp.title,
        opportunity_category: hyp.opportunity_category,
        status: hyp.status,
        rule_id: hyp.rule_id,
        rule_version: hyp.rule_version,
        rationale: hyp.rationale,
        assumptions: hyp.assumptions,
        alternatives: hyp.alternatives,
        missing_info: hyp.missing_info,
        validation_questions: hyp.validation_questions,
        intervention: hyp.intervention,
        decided_by: hyp.decided_by,
        decided_at: hyp.decided_at,
        decision_rationale: hyp.decision_rationale,
        created_at: hyp.created_at,
      },
      taxonomy: tax
        ? {
            problem: tax.problem,
            insufficientAlone: tax.insufficientAlone,
            mustNotGenerate: tax.mustNotGenerate,
          }
        : null,
      supporting: ev.rows
        .filter((r) => r.polarity === "supports")
        .map((r) => ({ claim_id: r.claim_id, claim_text: r.claim_text, status: r.status })),
      contradicting: ev.rows
        .filter((r) => r.polarity === "contradicts")
        .map((r) => ({ claim_id: r.claim_id, claim_text: r.claim_text, status: r.status })),
      decisions: decisions.rows,
      latestScore: sc.rows[0] ?? null,
    };
  } finally {
    client.release();
  }
}
