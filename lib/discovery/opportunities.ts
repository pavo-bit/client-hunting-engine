// Discovery opportunities (Prompt 4, blueprint §2/§3). Per-pipeline stable
// identity, repost resolution, collision routing, promotion links.
// Fail-closed boundaries (no owner words exist yet):
//   - pipeline 'direct_client' rows are REFUSED (409, O1) — schema permits
//     the value so no second migration is needed whichever way O1 goes.
//   - No auto-merge, no auto-promotion, no silent drops: collisions and
//     ambiguity route to existing human review (match_candidate).
// All functions take an explicit pool (repo convention).

import type { Pool } from "pg";
import { opportunityKey, type OpportunityPipeline } from "./keys";
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

export interface OpportunityRow {
  id: string;
  pipeline: string;
  opportunity_key: string;
  company_id: string | null;
  rule_id: string | null;
  status: string;
  solution_status: string;
}

export interface RegisterResult {
  id: string;
  key: string;
  created: boolean;
  status: string;
}

/**
 * Register a discovered opportunity idempotently. Same (pipeline, key) twice
 * returns the existing row (created:false) — retries and concurrent requests
 * cannot duplicate it (UNIQUE arbitrates; second writer reads the winner).
 *
 * TRANSACTIONAL (Part 1): the row, its audit entry AND its
 * `opportunity_registered` outbox event commit together. Previously the two
 * writes auto-committed separately, so a crash between them could leave an
 * opportunity with no audit row — and now an opportunity with no event would
 * additionally be invisible to Phase 2 forever. The conflict path performs no
 * writes (nothing changed, so no event is emitted).
 */
export async function registerOpportunity(
  pool: Pool,
  input: {
    pipeline: string;
    sourceKey: string;
    sourceRecordId?: string | null;
    fallback?: string;
    companyId?: string | null;
    ruleId?: string | null;
    /** Discovering run id for refresh-level counting (M5; optional). */
    runId?: string | null;
    actor: string;
  },
): Promise<RegisterResult> {
  if (input.pipeline !== "agency_partner" && input.pipeline !== "direct_client") {
    throw fail(422, "bad_pipeline", "pipeline must be agency_partner or direct_client");
  }
  if (input.pipeline === "direct_client") {
    throw fail(
      409,
      "direct_client_blocked",
      "direct-client pipeline scope is undecided (O1) — no direct-client rows until an owner decision",
    );
  }
  const key = opportunityKey({
    pipeline: input.pipeline as OpportunityPipeline,
    sourceKey: input.sourceKey,
    sourceRecordId: input.sourceRecordId ?? null,
    fallback: input.fallback,
  });
  requireActor(input.actor);
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      const r = await client.query(
        `insert into public.opportunity (pipeline, opportunity_key, company_id, rule_id, run_id)
         values ($1, $2, $3, $4, $5)
         on conflict (pipeline, opportunity_key) do nothing
         returning id, status`,
        [input.pipeline, key, input.companyId ?? null, input.ruleId ?? null, input.runId ?? null],
      );
      if (r.rows.length > 0) {
        const id = r.rows[0].id as string;
        await client.query(
          `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
           values ('opportunity', $1, $2, null, 'observed', $3)`,
          [id, input.actor, `registered ${key}`],
        );
        await appendDiscoveryEvent(client, {
          opportunityId: id,
          eventType: "opportunity_registered",
          payload: {
            opportunity_id: id,
            opportunity_key: key,
            pipeline: input.pipeline,
            company_id: input.companyId ?? null,
            rule_id: input.ruleId ?? null,
            run_id: input.runId ?? null,
            status: r.rows[0].status as string,
          },
          recordedBy: input.actor,
        });
        await client.query("commit");
        return { id, key, created: true, status: r.rows[0].status as string };
      }
      await client.query("commit");
      // Same client, never pool.query: with a small pool and concurrent
      // callers, a second checkout here can deadlock (every holder waiting
      // for a connection nobody will release).
      const existing = await client.query(
        "select id, status from public.opportunity where pipeline = $1 and opportunity_key = $2",
        [input.pipeline, key],
      );
      return {
        id: existing.rows[0].id as string,
        key,
        created: false,
        status: existing.rows[0].status as string,
      };
    } catch (e) {
      try {
        await client.query("rollback");
      } catch {
        /* connection already broken; the transaction dies with it */
      }
      throw e;
    }
  } finally {
    client.release();
  }
}

/**
 * Transition an opportunity's lifecycle status. Allowed edges only; every
 * transition is audit-logged with actor + reason. No silent drops: terminal
 * moves require non-empty reasons.
 */
const EDGES: Record<string, string[]> = {
  observed: ["eligible", "ineligible", "archived"],
  eligible: ["promoted", "ineligible", "stale", "archived"],
  ineligible: ["eligible", "archived"],
  promoted: ["stale", "archived"],
  stale: ["eligible", "archived"],
  archived: [],
};

export async function transitionOpportunity(
  pool: Pool,
  id: string,
  to: string,
  input: { reason: string; actor: string },
): Promise<{ id: string; status: string }> {
  if (!(input.reason ?? "").trim()) {
    throw fail(422, "reason_required", "a rationale is required for every transition");
  }
  requireActor(input.actor);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const cur = await client.query(
      "select id, status from public.opportunity where id = $1 for update",
      [id],
    );
    if (cur.rows.length === 0) {
      await client.query("rollback");
      throw fail(404, "opportunity_not_found", "opportunity not found");
    }
    const from: string = cur.rows[0].status;
    if (!(EDGES[from] ?? []).includes(to)) {
      await client.query("rollback");
      throw fail(409, "bad_transition", `transition ${from} -> ${to} is not allowed`);
    }
    await client.query(
      "update public.opportunity set status = $2, updated_at = now() where id = $1",
      [id, to],
    );
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('opportunity', $1, $2, $3, $4, $5)`,
      [id, input.actor, from, to, input.reason.trim().slice(0, 2000)],
    );
    // Same transaction: the state change and its notification are one atomic
    // fact. A transition without an event would desynchronize Phase 2.
    await appendDiscoveryEvent(client, {
      opportunityId: id,
      eventType: "opportunity_status_changed",
      payload: {
        opportunity_id: id,
        transition_from: from,
        transition_to: to,
        reason: input.reason.trim().slice(0, 2000),
      },
      recordedBy: input.actor,
    });
    await client.query("commit");
    return { id, status: to };
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

/**
 * Link a promoted opportunity to its hypothesis (created via the existing
 * engine). Promotion itself stays a human decision at the caller; this only
 * records the link. One promotion target per opportunity: re-promotion
 * returns the existing link instead of duplicating.
 */
export async function linkPromotion(
  pool: Pool,
  opportunityId: string,
  hypothesisId: string,
  actor: string,
): Promise<{ opportunityId: string; hypothesisId: string; created: boolean }> {
  requireActor(actor);
  const client = await pool.connect();
  try {
    const o = await client.query("select id, status from public.opportunity where id = $1", [opportunityId]);
    if (o.rows.length === 0) throw fail(404, "opportunity_not_found", "opportunity not found");
    if (o.rows[0].status !== "eligible" && o.rows[0].status !== "promoted") {
      throw fail(409, "not_promotable", "only eligible opportunities can be promoted (current: " + o.rows[0].status + ")");
    }
    const h = await client.query("select id from public.hypothesis where id = $1", [hypothesisId]);
    if (h.rows.length === 0) throw fail(404, "hypothesis_not_found", "hypothesis not found");
    // The promotion is recorded exactly once, as the eligible->promoted
    // transition audit row (no new table; transitionOpportunity owns it).
    // Re-promotion of an already-promoted opportunity is a no-op returning
    // the existing link — never a duplicate. A concurrent double-promotion
    // that loses the transition race resolves the same way (re-read below)
    // instead of surfacing a conflict.
    if (o.rows[0].status === "eligible") {
      try {
        await transitionOpportunity(pool, opportunityId, "promoted", {
          reason: `promoted to hypothesis ${hypothesisId}`,
          actor,
        });
      } catch (e: unknown) {
        const err = e as { code?: string };
        const re = await client.query("select status from public.opportunity where id = $1", [opportunityId]);
        if (err.code === "bad_transition" && re.rows[0]?.status === "promoted") {
          return { opportunityId, hypothesisId, created: false };
        }
        throw e;
      }
      return { opportunityId, hypothesisId, created: true };
    }
    return { opportunityId, hypothesisId, created: false };
  } finally {
    client.release();
  }
}

/** Attribution guard: audit actor CHECK (1..200) must never see a raw DB error. */
function requireActor(actor: string): void {
  if (!(actor ?? "").trim()) {
    throw fail(422, "actor_required", "acting operator identity is required for attribution");
  }
}
