// Opportunity briefs: explicit, traceable, versioned (T-010).
// A brief freezes one proposal version + the evidence behind it. Drafts are
// human-reviewed; NOTHING here sends, submits, or notifies externally.

import { createHash } from "crypto";
import type { Pool } from "pg";

export const BRIEF_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "needs_info",
  "rejected",
  "superseded",
  "archived",
] as const;

const ACTIVE_BRIEF = ["draft", "in_review", "needs_info", "approved"] as const;

const BRIEF_TRANSITIONS: Record<string, string[]> = {
  draft: ["in_review", "archived"],
  in_review: ["approved", "needs_info", "rejected", "archived"],
  needs_info: ["in_review", "archived"],
  approved: ["archived"],
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

export interface BriefResult {
  ref: string;
  warnings: string[];
}

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Explicit brief creation from an accepted proposal. */
export async function createBrief(
  pool: Pool,
  input: { proposalId: string; actor: string; reviewer?: string },
): Promise<BriefResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const p = await client.query(
      `select p.*, h.id as hid, h.title as htitle, h.status as hstatus,
              h.rule_id, h.rule_version, h.rationale as hrationale,
              c.id as cid, c.name as cname, c.domain_norm, c.registry_id,
              c.registry_type, c.country, c.country_code
       from public.project_option p
       join public.hypothesis h on h.id = p.hypothesis_id
       join public.company c on c.id = h.company_id
       where p.id = $1 for update`,
      [input.proposalId],
    );
    if (p.rows.length === 0) {
      await client.query("rollback");
      throw fail(404, "proposal_not_found", "proposal not found");
    }
    const row = p.rows[0];
    if (row.status !== "accepted") {
      await client.query("rollback");
      throw fail(
        409,
        "proposal_not_eligible",
        `briefs require an accepted proposal (current: ${row.status}); internal pursuit first`,
      );
    }
    const warnings: string[] = [];
    if (["rejected", "superseded"].includes(row.hstatus as string)) {
      warnings.push(
        `underlying hypothesis is ${row.hstatus} — brief flagged for review at creation`,
      );
    }
    const ev = await client.query(
      `select he.polarity, cl.claim_text, cl.claim_status
       from public.hypothesis_evidence he
       join public.claim cl on cl.id = he.claim_id
       where he.hypothesis_id = $1`,
      [row.hid],
    );
    const supports = ev.rows.filter((r) => r.polarity === "supports");
    const contradicts = ev.rows.filter((r) => r.polarity === "contradicts");
    const caps = await client.query(
      `select k.capability_key, c.name, c.status
       from public.project_capability k left join public.capability c on c.key = k.capability_key
       where k.project_option_id = $1`,
      [input.proposalId],
    );
    for (const cp of caps.rows) {
      if (cp.status !== "approved")
        warnings.push(
          `capability "${cp.capability_key}" is ${cp.status ?? "unknown"} — never present as an approved offering`,
        );
    }

    const inputs = {
      company: { id: row.cid, name: row.cname },
      hypothesis: { id: row.hid, rule: row.rule_id, version: row.rule_version, status: row.hstatus },
      proposal: { id: input.proposalId },
      claims: ev.rows.map((r) => ({ text: r.claim_text, status: r.claim_status })),
    };
    const lines: string[] = [
      `# Opportunity brief (DRAFT — internal, human review required)`,
      ``,
      `## Company context`,
      `- ${row.cname}${row.domain_norm ? ` (${row.domain_norm})` : ""}${row.country ? `, ${row.country}` : ""}`,
      row.registry_id
        ? `- Registry: ${row.registry_id}${row.registry_type ? ` (${row.registry_type})` : ""}`
        : `- Registry: not established`,
      `- Services below are stated ONLY as supported by assessed evidence.`,
      ...supports.map((s) => `- supported [${s.claim_status}]: ${s.claim_text}`),
      ...contradicts.map((s) => `- CONTRADICTED [${s.claim_status}]: ${s.claim_text}`),
      ``,
      `## Opportunity rationale`,
      `- Hypothesis (${row.hstatus}): ${row.htitle} [${row.rule_id ?? "?"} v${row.rule_version ?? "?"}]`,
      `- Rationale: ${row.hrationale ?? "see hypothesis record"}`,
      `- Verified facts vs inferences vs assumptions vs unknowns: see linked evidence statuses; nothing here upgrades them.`,
      `- Why investigate: operator judgment on the above — not a client-confirmed need.`,
      ``,
      `## Proposed project (v${row.version ?? 1})`,
      `- ${row.title}`,
      `- Scope in: ${row.scope_in ?? "—"}`,
      `- Explicitly out: ${row.scope_out ?? "—"}`,
      `- Effort: ${row.effort_lo_days ?? "?"}–${row.effort_hi_days ?? "?"} person-days${row.effort_lo_days == null ? " (insufficient information — no estimate)" : ""}`,
      `- Timeline: ${row.timeline_lo_weeks ?? "?"}–${row.timeline_hi_weeks ?? "?"} weeks (operator assumption or absent)`,
      `- Price: ${row.cost_low != null ? `${row.cost_low}–${row.cost_high} ${row.cost_currency} (${row.pricing_model ?? "model unspecified"})` : "absent — no budget invented"}`,
      `- Assumptions: ${row.assumptions}`,
      `- Capabilities: ${caps.rows.map((c) => `${c.capability_key} [${c.status ?? "unknown"}]`).join(", ") || "—"}`,
      ``,
      `## Action plan`,
      `- Next human action: review this brief, then validate open questions with the company directly.`,
      `- Validation questions: ${row.validation_questions ?? "see hypothesis record"}`,
      `- Risks/blockers: ${row.dependencies ?? "unstated"}`,
      `- Outreach: drafts only, prepared separately, sent manually by a human. Nothing here contacts anyone.`,
    ];
    const markdown = lines.join("\n");
    const frozen = sha(JSON.stringify(inputs));

    // Next reference: BR-YYYY-NNN from current max (local single-operator).
    // Concurrent creators may collide on the same number: each attempt runs
    // under a savepoint so a PK collision rolls back only the attempt,
    // after which we distinguish "active brief exists" (409) from a pure
    // ref race (retry with the next number).
    const year = new Date().getFullYear();
    let ref = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const mx = await client.query(
        `select ref from public.brief where ref like $1 order by ref desc limit 1`,
        [`BR-${year}-%`],
      );
      const n = mx.rows.length > 0 ? Number.parseInt(mx.rows[0].ref.split("-")[2], 10) + 1 : 1;
      ref = `BR-${year}-${String(n).padStart(3, "0")}`;
      await client.query("savepoint t010_brief_ref");
      try {
        await client.query(
          `insert into public.brief
             (ref, company_id, hypothesis_id, score_run_id, frozen_inputs_hash,
              markdown, status, reviewer, proposal_id, version)
           values ($1, $2, $3, null, $4, $5, 'draft', $6, $7, 1)`,
          [ref, row.cid, row.hid, frozen, markdown, input.reviewer ?? null, input.proposalId],
        );
        await client.query("release savepoint t010_brief_ref");
        break;
      } catch (e: unknown) {
        await client.query("rollback to savepoint t010_brief_ref");
        if ((e as { code?: string }).code !== "23505") throw e;
        const dup = await client.query(
          "select ref from public.brief where proposal_id = $1 and status = any($2) limit 1",
          [input.proposalId, [...ACTIVE_BRIEF]],
        );
        if (dup.rows.length > 0) {
          await client.query("rollback");
          throw fail(409, "brief_exists", `an active brief already exists: ${dup.rows[0].ref}`);
        }
        ref = "";
        continue; // ref race: retry with the next number
      }
    }
    if (ref === "") {
      await client.query("rollback");
      throw fail(500, "ref_failed", "could not allocate a brief reference");
    }
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('brief', $1, $2, null, 'draft', $3)`,
      [ref, input.actor, `brief drafted from proposal ${input.proposalId}`],
    );
    await client.query("commit");
    return { ref, warnings };
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
export async function decideBrief(
  pool: Pool,
  ref: string,
  input: { decision: string; reason: string; actor: string },
): Promise<{ ref: string; status: string }> {
  const map: Record<string, string> = {
    submit: "in_review",
    approve: "approved",
    request_info: "needs_info",
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
    const b = await client.query("select ref, status from public.brief where ref = $1 for update", [
      ref,
    ]);
    if (b.rows.length === 0) {
      await client.query("rollback");
      throw fail(404, "brief_not_found", "brief not found");
    }
    const from: string = b.rows[0].status;
    if (!(BRIEF_TRANSITIONS[from] ?? []).includes(to)) {
      await client.query("rollback");
      throw fail(409, "bad_transition", `cannot move brief from ${from} to ${to}`);
    }
    await client.query(
      `update public.brief set status = $2, decided_by = $3, decided_at = now(),
         decision_rationale = $4 where ref = $1`,
      [ref, to, input.actor, input.reason.trim()],
    );
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('brief', $1, $2, $3, $4, $5)`,
      [ref, input.actor, from, to, `${input.decision}: ${input.reason.trim()}`],
    );
    await client.query("commit");
    return { ref, status: to };
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

export interface PipelineInput {
  stage: string;
  note: string;
  nextAction?: string;
  followUpDate?: string;
  occurredAt?: string;
  actor: string;
}

const STAGES = [
  "research",
  "qualified",
  "ready_for_outreach",
  "contacted",
  "responded",
  "discovery",
  "proposal_talk",
  "won",
  "lost",
  "disqualified",
  "on_hold",
] as const;

/** Record a pipeline stage change: note required, history appended, brief updated. */
export async function recordPipelineEvent(
  pool: Pool,
  ref: string,
  input: PipelineInput,
): Promise<{ ref: string; stage: string }> {
  if (!STAGES.includes(input.stage as (typeof STAGES)[number]))
    throw fail(422, "bad_stage", `stage must be one of: ${STAGES.join(", ")}`);
  if (!(input.note ?? "").trim() || input.note!.length > 2000)
    throw fail(422, "note_required", "an explanation note (1..2000 chars) is required");
  let followUp: string | null = null;
  if (input.followUpDate !== undefined && input.followUpDate !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.followUpDate))
      throw fail(422, "bad_followup", "follow-up date must be YYYY-MM-DD");
    const d = new Date(`${input.followUpDate}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) throw fail(422, "bad_followup", "follow-up date is not a real date");
    const far = new Date();
    far.setFullYear(far.getFullYear() + 2);
    if (d > far) throw fail(422, "bad_followup", "follow-up date is unreasonably far out");
    followUp = input.followUpDate;
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const b = await client.query(
      "select ref, pipeline_stage from public.brief where ref = $1 for update",
      [ref],
    );
    if (b.rows.length === 0) {
      await client.query("rollback");
      throw fail(404, "brief_not_found", "brief not found");
    }
    const from: string | null = b.rows[0].pipeline_stage;
    await client.query(
      `insert into public.pipeline_event
         (brief_ref, from_stage, to_stage, note, next_action, follow_up_date, actor, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        ref,
        from,
        input.stage,
        input.note.trim(),
        input.nextAction?.trim() || null,
        followUp,
        input.actor,
        input.occurredAt ?? new Date().toISOString(),
      ],
    );
    await client.query(
      `update public.brief set pipeline_stage = $2, next_action = $3, follow_up_date = $4 where ref = $1`,
      [ref, input.stage, input.nextAction?.trim() || null, followUp],
    );
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('brief', $1, $2, $3, $4, $5)`,
      [ref, input.actor, from ?? "∅", input.stage, input.note.trim().slice(0, 500)],
    );
    await client.query("commit");
    return { ref, stage: input.stage };
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

const OUTCOMES = [
  "no_reply",
  "replied",
  "positive_response",
  "negative_response",
  "referral",
  "meeting",
  "discovery_meeting",
  "proposal",
  "won",
  "lost",
  "disqualified",
  "on_hold",
] as const;

/** Record a manually observed outcome. No automation, no inference. */
export async function recordOutcome(
  pool: Pool,
  ref: string,
  input: {
    channel?: string;
    outcome: string;
    rejectionCode?: string;
    note?: string;
    sentAtManual?: string;
    actor: string;
  },
): Promise<{ id: string }> {
  if (!OUTCOMES.includes(input.outcome as (typeof OUTCOMES)[number]))
    throw fail(422, "bad_outcome", `outcome must be one of: ${OUTCOMES.join(", ")}`);
  if (input.channel !== undefined && !["email", "dm", "contact_form", "call", "event", "other"].includes(input.channel))
    throw fail(422, "bad_channel", "unknown channel");
  if (
    input.rejectionCode !== undefined &&
    !["no_fit", "no_budget", "no_response", "bad_timing", "competitor", "chose_other", "other"].includes(
      input.rejectionCode,
    )
  )
    throw fail(422, "bad_rejection", "unknown rejection code");
  const client = await pool.connect();
  try {
    const b = await client.query("select ref from public.brief where ref = $1", [ref]);
    if (b.rows.length === 0) throw fail(404, "brief_not_found", "brief not found");
    const r = await client.query(
      `insert into public.outcome_log
         (brief_ref, sent_at_manual, channel, outcome, rejection_code, note, recorded_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        ref,
        input.sentAtManual ?? null,
        input.channel ?? null,
        input.outcome,
        input.rejectionCode ?? null,
        (input.note ?? "").slice(0, 4000) || null,
        input.actor,
      ],
    );
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('brief', $1, $2, 'outcome', $3, $4)`,
      [ref, input.actor, input.outcome, (input.note ?? "").slice(0, 500) || "outcome recorded"],
    );
    return { id: r.rows[0].id as string };
  } finally {
    client.release();
  }
}

export interface BriefWorkspace {
  brief: Record<string, unknown>;
  proposal: Record<string, unknown> | null;
  stale: boolean;
  staleReasons: string[];
  drafts: { id: string; channel: string; status: string; version: number; subject: string | null; body: string; unverified_points: string | null }[];
  outcomes: {
    id: string;
    outcome: string;
    channel: string | null;
    sent_at_manual: string | null;
    rejection_code: string | null;
    note: string | null;
    recorded_by: string;
  }[];
  pipeline: {
    id: string;
    from_stage: string | null;
    to_stage: string;
    note: string;
    next_action: string | null;
    follow_up_date: string | null;
    actor: string;
    occurred_at: string;
  }[];
}

/** Brief workspace aggregate + freshness vs hypothesis/proposal/evidence. */
export async function getBriefWorkspace(pool: Pool, ref: string): Promise<BriefWorkspace | null> {
  const client = await pool.connect();
  try {
    const b = await client.query("select * from public.brief where ref = $1", [ref]);
    if (b.rows.length === 0) return null;
    const brief = b.rows[0];
    let proposal: Record<string, unknown> | null = null;
    const staleReasons: string[] = [];
    if (brief.proposal_id) {
      const p = await client.query(
        `select p.*, h.status as hstatus from public.project_option p
         join public.hypothesis h on h.id = p.hypothesis_id where p.id = $1`,
        [brief.proposal_id],
      );
      if (p.rows.length > 0) {
        proposal = p.rows[0] as Record<string, unknown>;
        if (["rejected", "superseded"].includes(proposal["status"] as string))
          staleReasons.push(`linked proposal is ${proposal["status"]} — review required`);
        if (["rejected", "superseded"].includes(proposal["hstatus"] as string))
          staleReasons.push(`underlying hypothesis is ${proposal["hstatus"]} — review required`);
        const ev = await client.query(
          "select max(created_at) as m from public.hypothesis_evidence where hypothesis_id = $1",
          [proposal["hypothesis_id"]],
        );
        if (ev.rows[0].m && new Date(ev.rows[0].m as string) > new Date(brief.created_at as string))
          staleReasons.push("new evidence linked after this brief was drafted");
      } else {
        staleReasons.push("linked proposal is gone — review required");
      }
    }
    const drafts = (
      await client.query(
        `select id, channel, status, version, subject, body, unverified_points
         from public.outreach_draft where brief_ref = $1 order by version`,
        [ref],
      )
    ).rows as BriefWorkspace["drafts"];
    const outcomes = (
      await client.query(
        `select id, outcome, channel, sent_at_manual, rejection_code, note, recorded_by
         from public.outcome_log where brief_ref = $1 order by created_at`,
        [ref],
      )
    ).rows as BriefWorkspace["outcomes"];
    const pipeline = (
      await client.query(
        `select id, from_stage, to_stage, note, next_action, follow_up_date, actor, occurred_at
         from public.pipeline_event where brief_ref = $1 order by recorded_at`,
        [ref],
      )
    ).rows as BriefWorkspace["pipeline"];
    return {
      brief: brief as Record<string, unknown>,
      proposal,
      stale: staleReasons.length > 0,
      staleReasons,
      drafts,
      outcomes,
      pipeline,
    };
  } finally {
    client.release();
  }
}
