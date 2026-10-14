// Deterministic assessment rules (T-007). No ML, no opaque scores.
//
// STATUS MODEL: observed → corroborated → verified is the trust ladder;
// inferred/assumed are derivation markers, never auto-promoted; disputed /
// withdrawn / superseded are human-only terminal-ish states (withdrawn and
// superseded are terminal — new evidence starts a NEW claim).
// verified is HUMAN-ONLY: the engine may find a claim eligible, but only an
// authorized human decision promotes it. Corroboration requires INDEPENDENT
// origins: distinct (source_key, url-hostname) pairs. Two snapshots from one
// source, or two pages repeating one statement, do not corroborate.

import type { Pool } from "pg";

export const CLAIM_STATUSES = [
  "observed",
  "verified",
  "corroborated",
  "inferred",
  "assumed",
  "disputed",
  "withdrawn",
  "superseded",
] as const;

export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

const TERMINAL: ReadonlySet<string> = new Set(["withdrawn", "superseded"]);

export interface AssessInput {
  to: string;
  rationale: string;
  actor: string;
  /** Engine-driven transitions may only target corroborated. */
  automatic: boolean;
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

export function checkTransition(from: string, input: AssessInput): void {
  if (!CLAIM_STATUSES.includes(input.to as ClaimStatus))
    throw fail(422, "bad_status", `unknown claim status: ${input.to}`);
  if ((input.rationale ?? "").trim().length === 0)
    throw fail(422, "reason_required", "assessment rationale is required");
  if (TERMINAL.has(from))
    throw fail(409, "terminal_claim", `${from} claims are terminal; record new evidence as a new claim`);
  if (from === input.to)
    throw fail(409, "no_transition", `claim is already ${from}`);
  if (input.to === "verified" && input.automatic)
    throw fail(422, "verified_human_only", "verified requires an authorized human decision");
  if (input.automatic && input.to !== "corroborated")
    throw fail(422, "auto_limited", "automatic transitions may only promote to corroborated");
}

/** Distinct (source_key, url hostname) pairs = independent origins. */
export function independentOrigins(
  links: { source_key: string; snapshot_url: string }[],
): string[] {
  const out = new Set<string>();
  for (const l of links) {
    let host = l.snapshot_url;
    try {
      host = new URL(l.snapshot_url).hostname.toLowerCase();
    } catch {
      /* keep raw string */
    }
    out.add(`${l.source_key}\n${host}`);
  }
  return [...out];
}

export interface Recommendation {
  recommended: "corroborated" | null;
  eligibleVerified: boolean;
  reasons: string[];
}

/**
 * Pure recommendation from current status + supporting-origins evidence.
 * Never writes; never recommends verified (human-only).
 */
export function recommend(
  currentStatus: string,
  supportOrigins: string[],
  contradictCount: number,
): Recommendation {
  const reasons: string[] = [];
  const independent = new Set(supportOrigins).size;
  if (["observed", "inferred", "assumed"].includes(currentStatus)) {
    if (independent >= 2) {
      reasons.push(
        `${independent} independent origins support this claim — eligible for corroborated (automatic) and for verified (human decision only)`,
      );
      if (contradictCount > 0)
        reasons.push(
          `${contradictCount} contradicting item(s) exist — reviewer must acknowledge them before validating`,
        );
      return { recommended: "corroborated", eligibleVerified: true, reasons };
    }
    reasons.push(
      `only ${independent} independent origin(s); corroboration needs 2 from distinct sources`,
    );
    return { recommended: null, eligibleVerified: false, reasons };
  }
  if (currentStatus === "corroborated") {
    return {
      recommended: null,
      eligibleVerified: true,
      reasons: ["corroborated; verified requires an authorized human decision"],
    };
  }
  return { recommended: null, eligibleVerified: false, reasons: [`status ${currentStatus} is managed by human review`] };
}

/** Human or engine assessment with full audit trail (single transaction). */
export async function assessClaim(
  pool: Pool,
  claimId: string,
  input: AssessInput,
): Promise<{ claimId: string; from: string; to: string }> {
  checkTransition("", input); // shape checks first (from checked below)
  const client = await pool.connect();
  try {
    await client.query("begin");
    const c = await client.query(
      "select id, claim_status from public.claim where id = $1 for update",
      [claimId],
    );
    if (c.rows.length === 0) {
      await client.query("rollback");
      throw fail(404, "claim_not_found", "claim not found");
    }
    const from: string = c.rows[0].claim_status;
    checkTransition(from, input);
    await client.query(
      `insert into public.claim_assessment
         (claim_id, from_status, to_status, rationale, actor, automatic)
       values ($1, $2, $3, $4, $5, $6)`,
      [claimId, from, input.to, input.rationale.trim(), input.actor, input.automatic],
    );
    await client.query("update public.claim set claim_status = $2 where id = $1", [
      claimId,
      input.to,
    ]);
    // Human decisions clear the review flag; automatic ones must not
    // silently dismiss human triage.
    if (!input.automatic) {
      await client.query("update public.claim set needs_review = false where id = $1", [
        claimId,
      ]);
    }
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('claim', $1, $2, $3, $4, $5)`,
      [claimId, input.actor, from, input.to, `${input.automatic ? "[automatic] " : ""}${input.rationale.trim()}`],
    );
    await client.query("commit");
    return { claimId, from, to: input.to };
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

/** Flag a claim for human review (sets needs_review + audit; no status change). */
export async function flagClaim(
  pool: Pool,
  claimId: string,
  input: { reason: string; actor: string; flag: boolean },
): Promise<{ claimId: string; needsReview: boolean }> {
  if (!(input.reason ?? "").trim())
    throw fail(422, "reason_required", "a reason is required to (un)flag a claim");
  const client = await pool.connect();
  try {
    const c = await client.query("select id from public.claim where id = $1", [claimId]);
    if (c.rows.length === 0) throw fail(404, "claim_not_found", "claim not found");
    await client.query("update public.claim set needs_review = $2 where id = $1", [
      claimId,
      input.flag,
    ]);
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('claim', $1, $2, 'review-flag', $3, $4)`,
      [claimId, input.actor, input.flag ? "flagged" : "unflagged", input.reason.trim()],
    );
    return { claimId, needsReview: input.flag };
  } finally {
    client.release();
  }
}
