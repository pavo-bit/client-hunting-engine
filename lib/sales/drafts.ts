// Outreach drafts: editable, versioned, human-approved (T-010).
// Drafts are text a human copies into their own mail client. There is no
// send path in the schema (no sent-at/status-delivery columns), no queue,
// no worker, no automation — verified by the no-delivery scan in tests.
// Approval is BLOCKED while unverified_points remain (server-enforced).

import type { Pool } from "pg";

export const DRAFT_STATUSES = ["draft", "in_review", "ready"] as const;
const CHANNELS = ["email", "dm", "contact_form", "note"] as const;

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

export interface DraftInput {
  briefRef: string;
  channel: string;
  subject?: string;
  body: string;
  personalization?: string;
  unverifiedPoints?: string;
  actor: string;
}

function checkBody(body: string): void {
  if (body.trim().length === 0 || body.length > 10000)
    throw fail(422, "bad_body", "body must be 1..10000 characters");
}

export async function createDraft(pool: Pool, input: DraftInput): Promise<{ id: string; version: number }> {
  if (!CHANNELS.includes(input.channel as (typeof CHANNELS)[number]))
    throw fail(422, "bad_channel", `channel must be one of: ${CHANNELS.join(", ")}`);
  checkBody(input.body ?? "");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const b = await client.query("select ref from public.brief where ref = $1 for update", [
      input.briefRef,
    ]);
    if (b.rows.length === 0) {
      await client.query("rollback");
      throw fail(404, "brief_not_found", "brief not found");
    }
    const mx = await client.query(
      "select coalesce(max(version), 0)::int as v from public.outreach_draft where brief_ref = $1",
      [input.briefRef],
    );
    const version = (mx.rows[0].v as number) + 1;
    let id: string;
    try {
      const r = await client.query(
        `insert into public.outreach_draft
           (brief_ref, channel, subject, body, is_human_send_only,
            status, version, unverified_points, decided_by)
         values ($1, $2, $3, $4, true, 'draft', $5, $6, $7) returning id`,
        [
          input.briefRef,
          input.channel,
          input.subject?.trim() || null,
          input.body,
          version,
          input.unverifiedPoints?.trim() || null,
          input.actor,
        ],
      );
      id = r.rows[0].id as string;
    } catch (e: unknown) {
      await client.query("rollback");
      throw e;
    }
    // Personalization points are stored on the audit trail as review context
    // (what the draft claims and where it came from), never as sent content.
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('outreach_draft', $1, $2, null, 'draft', $3)`,
      [id, input.actor, `draft v${version} created${input.personalization ? `: grounded in ${input.personalization.slice(0, 300)}` : ""}`],
    );
    await client.query("commit");
    return { id, version };
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

/** Revise: new version row (history immutable); allowed from draft/in_review. */
export async function reviseDraft(
  pool: Pool,
  id: string,
  actor: string,
  changes: { subject?: string; body?: string; personalization?: string; unverifiedPoints?: string | null },
): Promise<{ id: string; version: number }> {
  if (changes.body !== undefined) checkBody(changes.body);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const cur = await client.query(
      "select * from public.outreach_draft where id = $1 for update",
      [id],
    );
    if (cur.rows.length === 0) {
      await client.query("rollback");
      throw fail(404, "draft_not_found", "draft not found");
    }
    const p = cur.rows[0];
    if (p.status === "ready") {
      await client.query("rollback");
      throw fail(409, "draft_ready", "ready drafts are immutable; create a new draft instead");
    }
    const mx = await client.query(
      "select coalesce(max(version), 0)::int as v from public.outreach_draft where brief_ref = $1",
      [p.brief_ref],
    );
    const version = (mx.rows[0].v as number) + 1;
    const r = await client.query(
      `insert into public.outreach_draft
         (brief_ref, channel, subject, body, is_human_send_only,
          status, version, unverified_points, decided_by)
       values ($1, $2, $3, $4, true, 'draft', $5, $6, $7) returning id`,
      [
        p.brief_ref,
        p.channel,
        changes.subject !== undefined ? changes.subject.trim() || null : p.subject,
        changes.body !== undefined ? changes.body : p.body,
        version,
        changes.unverifiedPoints !== undefined
          ? changes.unverifiedPoints?.trim() || null
          : p.unverified_points,
        actor,
      ],
    );
    const nextId: string = r.rows[0].id;
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('outreach_draft', $1, $2, 'revised', 'draft', $3)`,
      [nextId, actor, `revised from version ${p.version}`],
    );
    await client.query("commit");
    return { id: nextId, version };
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

/** Review decision: submit (draft→in_review), approve (in_review→ready),
 *  rework (in_review→draft). Approval requires a rationale AND zero
 *  unverified points — unsupported assertions can never be marked ready. */
export async function decideDraft(
  pool: Pool,
  id: string,
  input: { decision: string; reason: string; actor: string },
): Promise<{ id: string; status: string }> {
  if (!["submit", "approve", "rework"].includes(input.decision))
    throw fail(422, "bad_decision", "decision must be submit, approve, or rework");
  if (!(input.reason ?? "").trim())
    throw fail(422, "reason_required", "a rationale is required for every decision");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const cur = await client.query(
      "select id, status, unverified_points from public.outreach_draft where id = $1 for update",
      [id],
    );
    if (cur.rows.length === 0) {
      await client.query("rollback");
      throw fail(404, "draft_not_found", "draft not found");
    }
    const from: string = cur.rows[0].status;
    const to =
      input.decision === "submit" ? "in_review" : input.decision === "approve" ? "ready" : "draft";
    const allowed: Record<string, string[]> = {
      draft: ["in_review"],
      in_review: ["ready", "draft"],
      ready: [],
    };
    if (!(allowed[from] ?? []).includes(to)) {
      await client.query("rollback");
      throw fail(409, "bad_transition", `cannot move draft from ${from} to ${to}`);
    }
    if (to === "ready" && cur.rows[0].unverified_points) {
      await client.query("rollback");
      throw fail(
        409,
        "unverified_points",
        "draft has unverified assertions — resolve or remove them before approval",
      );
    }
    await client.query(
      `update public.outreach_draft set status = $2, decided_by = $3, decided_at = now() where id = $1`,
      [id, to, input.actor],
    );
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('outreach_draft', $1, $2, $3, $4, $5)`,
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
