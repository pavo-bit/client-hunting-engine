// Discovery-side eligibility (Prompt 4, blueprint §2/§3). Versioned,
// append-only decision scaffolding over explicit caller-supplied policy.
//
// Fail-closed design for the O10 gap: there is NO default/canonical gate set
// in code. evaluateEligibility() requires an explicit `policy` argument
// (version + gates); production has no blessed policy yet, so nothing here
// can bless an opportunity on its own. Tests supply explicit policies.
// When O10 lands, its blessed set becomes ONE named constant — added then,
// never guessed now. All functions take an explicit pool (repo convention).

import type { Pool } from "pg";
import { appendDiscoveryEvent } from "./events";

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

export interface EligibilityGate {
  /** Stable gate id, e.g. "identity-resolved". */
  id: string;
  /** True = passed. */
  passed: boolean;
  /** Human-readable reason, recorded verbatim. */
  reason: string;
}

export interface EligibilityPolicy {
  /** Policy version string, e.g. "eligibility-v1-proposal". Recorded, never trusted. */
  version: string;
  gates: EligibilityGate[];
}

export interface EligibilityRecord {
  id: string;
  opportunityId: string;
  version: number;
  decision: string;
  gateReasons: unknown;
  policyVersion: string;
}

/**
 * Evaluate + append a versioned decision. First failing gate decides
 * `ineligible`; all-passed decides `eligible`; caller-declared uncertainty
 * decides `needs_info`. Appends version N+1 over any prior versions —
 * history is never edited. Empty gate lists are rejected (a decision with
 * no stated gates explains nothing).
 */
export async function evaluateEligibility(
  pool: Pool,
  opportunityId: string,
  policy: EligibilityPolicy,
  input: { actor: string; uncertain?: boolean; uncertaintyNote?: string },
): Promise<EligibilityRecord> {
  if (!policy || typeof policy.version !== "string" || !policy.version.trim()) {
    throw fail(422, "bad_policy", "an explicit policy version is required (no default exists)");
  }
  if (!Array.isArray(policy.gates) || policy.gates.length === 0) {
    throw fail(422, "bad_policy", "an explicit non-empty gate list is required (no default exists)");
  }
  for (const [i, g] of policy.gates.entries()) {
    if (!g || typeof g.id !== "string" || !g.id.trim() || typeof g.passed !== "boolean") {
      throw fail(422, "bad_gate", `gate ${i} needs a string id and boolean passed`);
    }
  }
  if (!(input.actor ?? "").trim()) {
    throw fail(422, "actor_required", "deciding actor is required for attribution");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const o = await client.query(
      "select id, pipeline from public.opportunity where id = $1 for update",
      [opportunityId],
    );
    if (o.rows.length === 0) {
      await client.query("rollback");
      throw fail(404, "opportunity_not_found", "opportunity not found");
    }
    if (o.rows[0].pipeline === "direct_client") {
      await client.query("rollback");
      throw fail(
        409,
        "direct_client_blocked",
        "direct-client pipeline scope is undecided (O1) — no eligibility decisions for it",
      );
    }
    const cur = await client.query(
      "select coalesce(max(version), 0)::int as v from public.opportunity_eligibility where opportunity_id = $1",
      [opportunityId],
    );
    const failed = policy.gates.find((g) => !g.passed);
    const decision = input.uncertain ? "needs_info" : failed ? "ineligible" : "eligible";
    const gateReasons = policy.gates.map((g) => ({
      id: g.id,
      passed: g.passed,
      reason: (g.reason ?? "").slice(0, 500),
    }));
    if (input.uncertain && input.uncertaintyNote) {
      gateReasons.push({ id: "reviewer-uncertainty", passed: false, reason: input.uncertaintyNote.slice(0, 500) });
    }
    // Concurrent evaluations race on the version number; the UNIQUE
    // constraint arbitrates. On collision, re-read max and retry ONCE with
    // the next version instead of surfacing a raw constraint error.
    let version = (cur.rows[0].v as number) + 1;
    let row: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ins = await client.query(
          `insert into public.opportunity_eligibility
             (opportunity_id, version, decision, gate_reasons, policy_version, decided_by)
           values ($1, $2, $3, $4, $5, $6)
           returning id, opportunity_id, version, decision, gate_reasons, policy_version`,
          [
            opportunityId,
            version,
            decision,
            JSON.stringify(gateReasons),
            policy.version.trim().slice(0, 120),
            input.actor.trim().slice(0, 200),
          ],
        );
        row = ins.rows[0];
        break;
      } catch (e: unknown) {
        const code = (e as { code?: string }).code;
        if (code === "23505" && attempt === 0) {
          const again = await client.query(
            "select coalesce(max(version), 0)::int as v from public.opportunity_eligibility where opportunity_id = $1",
            [opportunityId],
          );
          version = (again.rows[0].v as number) + 1;
          continue;
        }
        throw e;
      }
    }
    if (!row) throw fail(500, "version_race", "could not assign an eligibility version");
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('opportunity', $1, $2, $3, $4, $5)`,
      [
        opportunityId,
        input.actor.trim().slice(0, 200),
        `eligibility-v${version - 1}`,
        `eligibility-v${version}:${decision}`,
        `policy ${policy.version.trim().slice(0, 120)}; ` +
          (failed ? `failed: ${failed.id}` : input.uncertain ? "reviewer uncertainty" : "all gates passed"),
      ],
    );
    // Same transaction: the decision and its notification commit together, so
    // Phase 2 can never observe one without the other.
    await appendDiscoveryEvent(client, {
      opportunityId,
      eventType: "eligibility_decided",
      payload: {
        opportunity_id: opportunityId,
        version,
        decision,
        policy_version: policy.version.trim().slice(0, 120),
      },
      recordedBy: input.actor.trim().slice(0, 200),
    });
    await client.query("commit");
    return {
      id: row.id as string,
      opportunityId: row.opportunity_id as string,
      version: row.version as number,
      decision: row.decision as string,
      gateReasons: row.gate_reasons as unknown,
      policyVersion: row.policy_version as string,
    };
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {
      /* already rolled back or connection broken */
    }
    throw e;
  } finally {
    client.release();
  }
}

/** Read the full version history (projection; never writes). */
export async function eligibilityHistory(pool: Pool, opportunityId: string): Promise<EligibilityRecord[]> {
  const r = await pool.query(
    `select id, opportunity_id, version, decision, gate_reasons, policy_version
     from public.opportunity_eligibility where opportunity_id = $1 order by version`,
    [opportunityId],
  );
  // Map explicitly: a bare cast of pg rows (snake_case) to EligibilityRecord
  // (camelCase) silently yields undefined for policyVersion/gateReasons, which
  // is exactly the history an operator needs to read (F3).
  return (r.rows as {
    id: string;
    opportunity_id: string;
    version: number;
    decision: string;
    gate_reasons: unknown;
    policy_version: string;
  }[]).map((row) => ({
    id: row.id,
    opportunityId: row.opportunity_id,
    version: row.version,
    decision: row.decision as EligibilityRecord["decision"],
    gateReasons: row.gate_reasons,
    policyVersion: row.policy_version,
  }));
}
