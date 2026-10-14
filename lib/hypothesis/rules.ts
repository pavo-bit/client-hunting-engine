// Deterministic hypothesis rules engine, version 1 (T-008).
// Pure evaluation core (unit-testable) + transactional persistence.
// No ML, no LLM, no probabilities, no web browsing. Source text is DATA:
// keyword matching never executes instructions and never leaks secrets
// (the engine reads no secrets and emits only rule text + quoted evidence).

import type { Pool } from "pg";
import {
  TAXONOMY,
  TAXONOMY_VERSION,
  type OpportunityCategory,
} from "./taxonomy";

export const RULES_VERSION = "1" as const;

export interface ClaimView {
  id: string;
  predicate: string | null;
  status: string;
  stale: boolean;
  claim_text: string;
  source_key: string;
  snapshot_url: string;
  needs_review: boolean;
}

export interface RuleDef {
  id: string;
  version: string;
  category: OpportunityCategory;
  title: string;
  /** Claim predicates that may support this rule. */
  predicates: string[];
  /** Claim statuses usable as support. */
  usableStatuses: string[];
  /** Case-insensitive text keywords (at least one must occur). Empty = predicate suffices. */
  keywords: string[];
}

export const RULES: RuleDef[] = [
  {
    id: "R-PORTAL-01",
    version: RULES_VERSION,
    category: "portals_dashboards",
    title: "Client onboarding / portal digitization may be worth investigating",
    predicates: ["announced", "contact"],
    usableStatuses: ["observed", "corroborated", "inferred"],
    keywords: ["portal", "login", "client area", "onboarding", "intake"],
  },
  {
    id: "R-HIRING-01",
    version: RULES_VERSION,
    category: "automation_workflows",
    title: "Coordination/tooling needs under team growth are unknown and worth asking about",
    predicates: ["hiring"],
    usableStatuses: ["observed", "corroborated", "inferred"],
    keywords: [],
  },
  {
    id: "R-INTEGRATION-01",
    version: RULES_VERSION,
    category: "integrations",
    title: "System-integration scope may be worth mapping",
    predicates: ["announced"],
    usableStatuses: ["observed", "corroborated", "inferred"],
    keywords: ["api", "integration", "webhook", "sync", "zapier"],
  },
  {
    id: "R-REPORTING-01",
    version: RULES_VERSION,
    category: "reporting_analytics",
    title: "Operational-visibility gaps are unknown and worth asking about",
    predicates: ["announced", "hiring"],
    usableStatuses: ["observed", "corroborated", "inferred"],
    keywords: ["report", "dashboard", "analytics", "visibility", "spreadsheet"],
  },
  {
    id: "R-TESTING-01",
    version: RULES_VERSION,
    category: "testing_qa",
    title: "QA practice questions may be worth asking — never asserted",
    predicates: ["announced", "hiring"],
    usableStatuses: ["observed", "corroborated"],
    keywords: ["qa", "testing", "quality", "bug", "release"],
  },
];

export interface RuleEvaluation {
  ruleId: string;
  version: string;
  category: OpportunityCategory;
  fired: boolean;
  supportingClaimIds: string[];
  contradictClaimIds: string[];
  assumedTexts: string[];
  reasons: string[];
  missing: string[];
}

function textMatches(text: string, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const t = text.toLowerCase();
  return keywords.some((k) => t.includes(k.toLowerCase()));
}

/**
 * Pure rule evaluation over eligible claims. Assumed-status claims are
 * collected as assumptions (never support). Withdrawn/superseded/disputed/
 * stale claims are excluded from support. Contradiction links ride along
 * for visibility. Deterministic: same inputs, same outputs.
 */
export function evaluateRules(
  claims: ClaimView[],
  contradictions: Map<string, string[]>,
): RuleEvaluation[] {
  const eligible = claims.filter(
    (c) => ["observed", "corroborated", "inferred"].includes(c.status) && !c.stale,
  );
  const assumed = claims
    .filter((c) => c.status === "assumed")
    .map((c) => `assumed (unverified): ${c.claim_text.slice(0, 200)}`);
  return RULES.map((rule) => {
    const matched = eligible.filter(
      (c) =>
        rule.predicates.includes(c.predicate ?? "") &&
        textMatches(c.claim_text, rule.keywords),
    );
    const reasons: string[] = [];
    if (matched.length === 0) {
      reasons.push(
        `no eligible ${rule.predicates.join("/")} claim${rule.keywords.length > 0 ? ` mentioning ${rule.keywords.join(", ")}` : ""} (fresh, non-terminal status required)`,
      );
      return {
        ruleId: rule.id,
        version: rule.version,
        category: rule.category,
        fired: false,
        supportingClaimIds: [],
        contradictClaimIds: [],
        assumedTexts: assumed,
        reasons,
        missing: [],
      };
    }
    const contra = matched.flatMap((c) => contradictions.get(c.id) ?? []);
    reasons.push(
      `${matched.length} eligible claim(s) (${matched.map((c) => c.status).join(", ")}) match ${rule.id} v${rule.version}`,
    );
    if (contra.length > 0)
      reasons.push(`${contra.length} contradicting item(s) preserved for review`);
    const tax = TAXONOMY.find((t) => t.category === rule.category)!;
    return {
      ruleId: rule.id,
      version: rule.version,
      category: rule.category,
      fired: true,
      supportingClaimIds: matched.map((c) => c.id),
      contradictClaimIds: [...new Set(contra)],
      assumedTexts: assumed,
      reasons,
      missing: [
        "Direct confirmation with the company (nothing here is proven)",
        ...tax.questions.slice(0, 2),
      ],
    };
  });
}

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

const DECISIONS = ["validate", "defer", "reject", "request_evidence", "supersede"] as const;

export interface GenerateResult {
  companyId: string;
  hypotheses: { id: string; ruleId: string; status: string; created: boolean }[];
  ruleResults: { ruleId: string; fired: boolean; reasons: string[] }[];
  noSupportedHypothesis: boolean;
}

/** Load eligible claim views + contradiction map for one company. */
async function loadClaimViews(
  pool: Pool,
  companyId: string,
): Promise<{ claims: ClaimView[]; contradictions: Map<string, string[]> }> {
  const client = await pool.connect();
  try {
    const claims = (
      await client.query(
        `select c.id, c.predicate, c.claim_status as status, c.claim_text,
                (c.expires_at is not null and c.expires_at < now()) as stale,
                s.source_key, s.url as snapshot_url, c.needs_review
         from public.claim c join public.snapshot s on s.id = c.snapshot_id
         where c.company_id = $1`,
        [companyId],
      )
    ).rows as ClaimView[];
    const links = (
      await client.query(
        `select e.claim_id, e.linked_claim_id from public.claim_evidence e
         join public.claim c on c.id = e.claim_id
         where c.company_id = $1 and e.polarity = 'contradicts'`,
        [companyId],
      )
    ).rows as { claim_id: string; linked_claim_id: string | null }[];
    const contradictions = new Map<string, string[]>();
    for (const l of links) {
      const arr = contradictions.get(l.claim_id) ?? [];
      arr.push(l.linked_claim_id ?? "(snapshot contradiction)");
      contradictions.set(l.claim_id, arr);
    }
    return { claims, contradictions };
  } finally {
    client.release();
  }
}

function rationaleFor(rule: RuleDef, ev: RuleEvaluation): string {
  const tax = TAXONOMY.find((t) => t.category === rule.category)!;
  return [
    `Rule ${rule.id} v${rule.version}: ${ev.reasons.join("; ")}.`,
    `Problem considered: ${tax.problem}`,
    `This is a reasoned possibility, not an established fact.`,
  ].join(" ");
}

/**
 * Generate (or re-evaluate) hypotheses for a company. Idempotent per
 * (company, rule): open rows are reused and topped up with new evidence;
 * materially changed decided rows are superseded (audit-stamped) and
 * replaced. Merged records are skipped (hypotheses belong to canonical).
 */
export async function generateHypotheses(
  pool: Pool,
  companyId: string,
  actor: string,
): Promise<GenerateResult> {
  const client = await pool.connect();
  try {
    const co = await client.query(
      "select id, merged_into from public.company where id = $1",
      [companyId],
    );
    if (co.rows.length === 0) throw fail(404, "company_not_found", "company not found");
    if (co.rows[0].merged_into !== null)
      return { companyId, hypotheses: [], ruleResults: [], noSupportedHypothesis: true };
  } finally {
    client.release();
  }

  const { claims, contradictions } = await loadClaimViews(pool, companyId);
  const evals = evaluateRules(claims, contradictions);
  const out: GenerateResult = {
    companyId,
    hypotheses: [],
    ruleResults: evals.map((e) => ({ ruleId: e.ruleId, reasons: e.reasons, fired: e.fired })),
    noSupportedHypothesis: !evals.some((e) => e.fired),
  };

  for (const ev of evals) {
    if (!ev.fired) continue;
    const rule = RULES.find((r) => r.id === ev.ruleId)!;
    const tax = TAXONOMY.find((t) => t.category === rule.category)!;
    const c2 = await pool.connect();
    try {
      await c2.query("begin");
      const existing = await c2.query(
        `select id, status from public.hypothesis
         where company_id = $1 and rule_id = $2
           and status in ('generated', 'needs_review', 'deferred')
         order by created_at desc limit 1`,
        [companyId, rule.id],
      );
      if (existing.rows.length > 0) {
        // Top up evidence links (idempotent) + audit the re-evaluation.
        // Only real claim ids can link (snapshot-level contradictions stay
        // visible on the claim itself, counted in the rationale).
        const hid: string = existing.rows[0].id;
        for (const cid of [...ev.supportingClaimIds, ...ev.contradictClaimIds]) {
          const linked = await c2.query("select id from public.claim where id = $1", [cid]);
          if (linked.rows.length === 0) continue;
          await c2.query(
            `insert into public.hypothesis_evidence (hypothesis_id, claim_id, polarity)
             values ($1, $2, $3) on conflict do nothing`,
            [hid, cid, ev.contradictClaimIds.includes(cid) ? "contradicts" : "supports"],
          );
        }
        await c2.query(
          `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
           values ('hypothesis', $1, $2, $3, $3, 're-evaluated; evidence topped up')`,
          [hid, actor, existing.rows[0].status],
        );
        await c2.query("commit");
        out.hypotheses.push({ id: hid, ruleId: rule.id, status: existing.rows[0].status, created: false });
        continue;
      }
      // Material change over a decided row? Supersede it (history kept).
      const decided = await c2.query(
        `select id, status from public.hypothesis
         where company_id = $1 and rule_id = $2
           and status in ('rejected', 'validated')
         order by created_at desc limit 1`,
        [companyId, rule.id],
      );
      let superseded: string | null = null;
      if (decided.rows.length > 0) {
        const linked = await c2.query(
          "select claim_id from public.hypothesis_evidence where hypothesis_id = $1",
          [decided.rows[0].id],
        );
        const known = new Set(linked.rows.map((r) => r.claim_id as string));
        const fresh = [...ev.supportingClaimIds, ...ev.contradictClaimIds].some((id) => !known.has(id));
        if (fresh) {
          superseded = decided.rows[0].id as string;
          await c2.query("update public.hypothesis set status = 'superseded' where id = $1", [superseded]);
          await c2.query(
            `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
             values ('hypothesis', $1, $2, $3, 'superseded', 'new material evidence; replaced')`,
            [superseded, actor, decided.rows[0].status],
          );
        } else {
          await c2.query("commit");
          out.hypotheses.push({
            id: decided.rows[0].id as string,
            ruleId: rule.id,
            status: decided.rows[0].status as string,
            created: false,
          });
          continue;
        }
      }
      const status = ev.contradictClaimIds.length > 0 ? "needs_review" : "generated";
      const ins = await c2.query(
        `insert into public.hypothesis
           (company_id, title, opportunity_category, status, confidence_rationale,
            rule_id, rule_version, rationale, assumptions, alternatives,
            missing_info, validation_questions, intervention)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         on conflict (company_id, rule_id)
         where rule_id is not null and status in ('generated', 'needs_review', 'deferred')
         do nothing returning id`,
        [
          companyId,
          rule.title,
          rule.category,
          status,
          `rule ${rule.id} v${rule.version}; evidence statuses observed/corroborated/inferred; see rationale`,
          rule.id,
          rule.version,
          rationaleFor(rule, ev),
          ev.assumedTexts.length > 0
            ? `Unverified assumptions (not evidence): ${ev.assumedTexts.join(" | ").slice(0, 2000)}`
            : "No recorded assumptions.",
          tax.alternatives.join(" | ").slice(0, 2000),
          ev.missing.join(" | ").slice(0, 2000),
          tax.questions.join(" | ").slice(0, 2000),
          `PROPOSAL ONLY — ${tax.interventions.join(" | ").slice(0, 2000)}`,
        ],
      );
      // Race safety: unique index may swallow the insert when a concurrent
      // run wins; fall back to reading the surviving row.
      let hid: string;
      if (ins.rows.length > 0) {
        hid = ins.rows[0].id as string;
      } else {
        const again = await c2.query(
          `select id, status from public.hypothesis
           where company_id = $1 and rule_id = $2
             and status in ('generated', 'needs_review', 'deferred')
           order by created_at desc limit 1`,
          [companyId, rule.id],
        );
        hid = again.rows[0].id as string;
      }
      for (const cid of ev.supportingClaimIds) {
        await c2.query(
          `insert into public.hypothesis_evidence (hypothesis_id, claim_id, polarity)
           values ($1, $2, 'supports') on conflict do nothing`,
          [hid, cid],
        );
      }
      for (const cid of ev.contradictClaimIds) {
        const linked = await c2.query("select id from public.claim where id = $1", [cid]);
        if (linked.rows.length === 0) continue;
        await c2.query(
          `insert into public.hypothesis_evidence (hypothesis_id, claim_id, polarity)
           values ($1, $2, 'contradicts') on conflict do nothing`,
          [hid, cid],
        );
      }
      await c2.query(
        `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
         values ('hypothesis', $1, $2, null, $3, $4)`,
        [
          hid,
          actor,
          status,
          `generated by ${rule.id} v${rule.version}${superseded ? `; supersedes ${superseded}` : ""}`,
        ],
      );
      await c2.query("commit");
      const st = await c2.query("select status from public.hypothesis where id = $1", [hid]);
      out.hypotheses.push({ id: hid, ruleId: rule.id, status: st.rows[0].status as string, created: ins.rows.length > 0 });
    } catch (e) {
      try {
        await c2.query("rollback");
      } catch {
        /* already rolled back */
      }
      throw e;
    } finally {
      c2.release();
    }
  }
  return out;
}

/** Human review decision (validate/defer/reject/request_evidence/supersede). */export async function decideHypothesis(
  pool: Pool,
  id: string,
  input: { decision: string; reason: string; actor: string },
): Promise<{ id: string; status: string }> {
  if (!DECISIONS.includes(input.decision as (typeof DECISIONS)[number]))
    throw fail(422, "bad_decision", `decision must be one of: ${DECISIONS.join(", ")}`);
  if (!(input.reason ?? "").trim())
    throw fail(422, "reason_required", "a rationale is required for every decision");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const h = await client.query(
      "select id, status from public.hypothesis where id = $1 for update",
      [id],
    );
    if (h.rows.length === 0) {
      await client.query("rollback");
      throw fail(404, "hypothesis_not_found", "hypothesis not found");
    }
    const from: string = h.rows[0].status;
    if (from === "superseded") {
      await client.query("rollback");
      throw fail(409, "terminal", "superseded hypotheses stay decided; generate anew after new evidence");
    }
    const to =
      input.decision === "validate"
        ? "validated"
        : input.decision === "defer"
          ? "deferred"
          : input.decision === "reject"
            ? "rejected"
            : input.decision === "supersede"
              ? "superseded"
              : from; // request_evidence keeps status
    await client.query(
      `update public.hypothesis set status = $2, decided_by = $3, decided_at = now(),
         decision_rationale = $4, rejection_reason = case when $2 = 'rejected' then $4 else null end,
         validated_at = case when $2 = 'validated' then now() else validated_at end
       where id = $1`,
      [id, to, input.actor, input.reason.trim()],
    );
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('hypothesis', $1, $2, $3, $4, $5)`,
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
