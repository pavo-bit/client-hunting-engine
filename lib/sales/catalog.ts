// Service catalog: structure is ours, content needs the owner (D-004).
// Rows carry approval status; NOTHING here presents draft content as an
// approved offering — brief builders and UI must label unapproved entries.
// Status changes require rationale + audit; the human operator may be the
// owner, in which case the audit trail records who approved what and why.

import type { Pool } from "pg";

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

export interface CapabilityRow {
  key: string;
  name: string;
  description: string | null;
  entry_criteria: string | null;
  owner: string | null;
  is_placeholder: boolean;
  status: string;
}

export async function listCapabilities(pool: Pool): Promise<CapabilityRow[]> {
  const r = await pool.query(
    `select key, name, description, entry_criteria, owner, is_placeholder, status
     from public.capability order by key`,
  );
  return r.rows as CapabilityRow[];
}

/** Approval-state change with rationale (audited). Content edits stay manual. */
export async function setCapabilityStatus(
  pool: Pool,
  key: string,
  input: { status: string; reason: string; actor: string },
): Promise<{ key: string; status: string }> {
  if (!["draft", "needs_owner_review", "approved"].includes(input.status))
    throw fail(422, "bad_status", "status must be draft, needs_owner_review, or approved");
  if (!(input.reason ?? "").trim())
    throw fail(422, "reason_required", "a rationale is required to change approval state");
  const client = await pool.connect();
  try {
    const cur = await client.query("select key, status from public.capability where key = $1", [
      key,
    ]);
    if (cur.rows.length === 0) throw fail(404, "capability_not_found", "capability not found");
    await client.query("update public.capability set status = $2 where key = $1", [
      key,
      input.status,
    ]);
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('capability', $1, $2, $3, $4, $5)`,
      [key, input.actor, cur.rows[0].status, input.status, input.reason.trim()],
    );
    return { key, status: input.status };
  } finally {
    client.release();
  }
}
