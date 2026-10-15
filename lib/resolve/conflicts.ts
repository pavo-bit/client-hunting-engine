// Identity-conflict review artifacts (Prompt 5, migration M7).
//
// A discovery record that collides with an existing canonical company is
// refused from becoming a company (canonical uniques, D-011). This module
// CAPTURES what the source claimed so a human can decide later - it never
// merges, never overwrites, never invents identity. The conflicting entity is
// deliberately NOT a company row: creating one would pre-decide a merge.
//
// Rules that must hold for every function here:
//   - no write ever sets company.merged_into (zero merge semantics)
//   - captures are idempotent per (run, source record) - reruns append nothing
//   - every state change is audited with actor + reason

import type { Pool } from "pg";

export type ConflictRule = "registry_scoped" | "domain_exact";
export type ConflictStatus = "pending" | "reviewed" | "deferred";

export interface IdentityConflict {
  id: string;
  runId: string;
  sourceRecordId: string;
  companyId: string;
  observedName: string | null;
  observedDomain: string | null;
  observedRegistryId: string | null;
  observedCountryCode: string | null;
  rule: ConflictRule;
  detail: string;
  status: ConflictStatus;
  createdAt: string;
}

interface ConflictRow {
  id: string;
  run_id: string;
  source_record_id: string;
  company_id: string;
  observed_name: string | null;
  observed_domain: string | null;
  observed_registry_id: string | null;
  observed_country_code: string | null;
  rule: ConflictRule;
  detail: string;
  status: ConflictStatus;
  created_at: Date;
}

function fail(status: number, code: string, message: string): Error & { status: number; code: string } {
  const e = new Error(message) as Error & { status: number; code: string };
  e.status = status;
  e.code = code;
  return e;
}

const clip = (v: string | null | undefined, max: number): string | null => {
  const t = (v ?? "").trim();
  return t.length === 0 ? null : t.slice(0, max);
};

function toConflict(r: ConflictRow): IdentityConflict {
  return {
    id: r.id,
    runId: r.run_id,
    sourceRecordId: r.source_record_id,
    companyId: r.company_id,
    observedName: r.observed_name,
    observedDomain: r.observed_domain,
    observedRegistryId: r.observed_registry_id,
    observedCountryCode: r.observed_country_code,
    rule: r.rule,
    detail: r.detail,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/**
 * Capture one conflicted observation. Idempotent: re-running the same source
 * record against the same run returns the existing row (created:false).
 */
export async function recordIdentityConflict(
  pool: Pool,
  input: {
    runId: string;
    sourceRecordId: string;
    companyId: string;
    rule: ConflictRule;
    detail: string;
    observedName?: string | null;
    observedDomain?: string | null;
    observedRegistryId?: string | null;
    observedCountryCode?: string | null;
  },
): Promise<{ conflict: IdentityConflict; created: boolean }> {
  const sourceRecordId = (input.sourceRecordId ?? "").trim();
  if (sourceRecordId.length < 1 || sourceRecordId.length > 300) {
    throw fail(422, "bad_source_record", "sourceRecordId must be 1..300 characters");
  }
  const detail = (input.detail ?? "").trim();
  if (detail.length < 1 || detail.length > 2000) {
    throw fail(422, "bad_detail", "detail must be 1..2000 characters");
  }
  if (input.rule !== "registry_scoped" && input.rule !== "domain_exact") {
    throw fail(422, "bad_rule", "rule must be registry_scoped or domain_exact");
  }
  const r = await pool.query(
    `insert into public.identity_conflict
       (run_id, source_record_id, company_id, rule, detail,
        observed_name, observed_domain, observed_registry_id, observed_country_code)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (run_id, source_record_id) do nothing
     returning id, run_id, source_record_id, company_id, observed_name, observed_domain,
               observed_registry_id, observed_country_code, rule, detail, status, created_at`,
    [
      input.runId,
      sourceRecordId,
      input.companyId,
      input.rule,
      detail,
      clip(input.observedName, 300),
      clip(input.observedDomain, 300),
      clip(input.observedRegistryId, 300),
      clip(input.observedCountryCode, 8),
    ],
  );
  if (r.rows.length > 0) {
    return { conflict: toConflict(r.rows[0] as ConflictRow), created: true };
  }
  const again = await pool.query(
    `select id, run_id, source_record_id, company_id, observed_name, observed_domain,
            observed_registry_id, observed_country_code, rule, detail, status, created_at
     from public.identity_conflict where run_id = $1 and source_record_id = $2`,
    [input.runId, sourceRecordId],
  );
  if (again.rows.length === 0) throw fail(500, "conflict_lost", "conflict row vanished");
  return { conflict: toConflict(again.rows[0] as ConflictRow), created: false };
}

/**
 * Attribution for a captured conflict (F10).
 *
 * `identity_conflict` deliberately stores no actor column: the capture is
 * always performed inside a discovery run, and that run already records who
 * created it (`discovery_run.created_by`). Adding a second copy of the same
 * caller-supplied label would add redundancy without adding truth, and would
 * freeze one actor string into an immutable audit row.
 *
 * What this does NOT settle: whether `created_by` is a verified human identity.
 * Through the HTTP routes it is the authenticated session operator; through the
 * bearer service credential it is the configured service identity. Changing
 * that mapping is a service-identity policy decision (owner) and is recorded as
 * blocked, not guessed.
 */
export async function conflictAttribution(
  pool: Pool,
  conflictId: string,
): Promise<{
  conflictId: string;
  runId: string;
  capturedBy: string | null;
  runStatus: string | null;
}> {
  const r = await pool.query(
    `select c.run_id, c.created_at, r.created_by, r.status as run_status
     from public.identity_conflict c
     join public.discovery_run r on r.id = c.run_id
     where c.id = $1`,
    [conflictId],
  );
  if (r.rows.length === 0) return { conflictId, runId: "", capturedBy: null, runStatus: null };
  return {
    conflictId,
    runId: r.rows[0].run_id as string,
    capturedBy: (r.rows[0].created_by as string | null) ?? null,
    runStatus: (r.rows[0].run_status as string | null) ?? null,
  };
}

/** Read conflicts for a run or a company. Bounded; newest first. */
export async function listIdentityConflicts(
  pool: Pool,
  filter: { runId?: string; companyId?: string; status?: ConflictStatus; limit?: number },
): Promise<IdentityConflict[]> {
  const params: unknown[] = [];
  const conds: string[] = [];
  if (filter.runId) {
    params.push(filter.runId);
    conds.push(`run_id = $${params.length}`);
  }
  if (filter.companyId) {
    params.push(filter.companyId);
    conds.push(`company_id = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    conds.push(`status = $${params.length}`);
  }
  params.push(Math.min(Math.max(filter.limit ?? 50, 1), 200));
  const where = conds.length > 0 ? `where ${conds.join(" and ")}` : "";
  const r = await pool.query(
    `select id, run_id, source_record_id, company_id, observed_name, observed_domain,
            observed_registry_id, observed_country_code, rule, detail, status, created_at
     from public.identity_conflict ${where}
     order by created_at desc, id desc limit $${params.length}`,
    params,
  );
  return (r.rows as ConflictRow[]).map(toConflict);
}

/**
 * Operator decision on a captured conflict. `reviewed` and `deferred` BOTH
 * require an actor + reason; this function changes nothing about the companies
 * (no merge, no overwrite) - the outcome of an identity decision is made in
 * the existing resolution workflow, by a human, with its own audit trail.
 */
export async function decideIdentityConflict(
  pool: Pool,
  id: string,
  input: { status: Exclude<ConflictStatus, "pending">; actor: string; reason: string },
): Promise<IdentityConflict> {
  const actor = (input.actor ?? "").trim();
  const reason = (input.reason ?? "").trim();
  if (actor.length < 1 || actor.length > 200) {
    throw fail(422, "actor_required", "acting operator identity is required for attribution");
  }
  if (reason.length < 1 || reason.length > 2000) {
    throw fail(422, "reason_required", "a rationale is required for every decision");
  }
  if (input.status !== "reviewed" && input.status !== "deferred") {
    throw fail(422, "bad_status", "status must be reviewed or deferred");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const cur = await client.query(
      `update public.identity_conflict
       set status = $2, decided_by = $3, decided_at = now(), decision_reason = $4
       where id = $1 and status = 'pending'
       returning id, run_id, source_record_id, company_id, observed_name, observed_domain,
                 observed_registry_id, observed_country_code, rule, detail, status, created_at`,
      [id, input.status, actor, reason],
    );
    if (cur.rows.length === 0) {
      const found = await client.query("select id from public.identity_conflict where id = $1", [id]);
      await client.query("rollback");
      if (found.rows.length === 0) throw fail(404, "conflict_not_found", "identity conflict not found");
      throw fail(409, "already_decided", "this conflict was already decided");
    }
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('identity_conflict', $1, $2, 'pending', $3, $4)`,
      [id, actor, input.status, reason],
    );
    await client.query("commit");
    return toConflict(cur.rows[0] as ConflictRow);
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {
      /* connection already broken */
    }
    throw e;
  } finally {
    client.release();
  }
}