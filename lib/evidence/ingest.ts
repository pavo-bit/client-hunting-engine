// Observation ingestion (T-007): snapshots + claims with provenance.
// Idempotent on content hash: re-ingesting identical material returns the
// existing snapshot without duplicating. Companies are never modified here.

import type { Pool } from "pg";
import { observationHash } from "./hash";

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

const PREDICATES = [
  "identity",
  "provides_service",
  "operates_in",
  "announced",
  "hiring",
  "contact",
  "other",
] as const;

export interface IngestObservationInput {
  companyId: string;
  sourceKey: string;
  url: string;
  excerpt?: string;
  observedAt?: string;
  retentionClass?: string;
  actor: string;
}

export interface IngestClaimInput {
  predicate?: string;
  text: string;
  initialStatus?: string;
  reliability: "A" | "B" | "C" | "D";
  credibility: number;
  expiresAt?: string;
}

function checkUrl(url: string): void {
  if (!url.startsWith("http://") && !url.startsWith("https://"))
    throw fail(422, "bad_url", "observation URL must be http(s)");
  if (url.length > 2000) throw fail(422, "bad_url", "URL exceeds 2000 characters");
  if (/\s/.test(url)) throw fail(422, "bad_url", "URL must not contain whitespace");
}

export async function ingestObservation(
  pool: Pool,
  obs: IngestObservationInput,
  claim?: IngestClaimInput,
): Promise<{ snapshotId: string; existed: boolean; claimId: string | null }> {
  const excerpt = obs.excerpt ?? "";
  if (Buffer.byteLength(excerpt, "utf8") > 2000)
    throw fail(422, "excerpt_too_large", "excerpt exceeds 2000 bytes");
  checkUrl(obs.url);
  const retention = obs.retentionClass ?? "page";
  if (!["registry", "directory", "page", "social", "manual"].includes(retention))
    throw fail(422, "bad_retention", "unknown retention class");

  let claimText = claim?.text.trim() ?? "";
  if (claim) {
    if (claimText.length === 0 || claimText.length > 2000)
      throw fail(422, "bad_claim", "claim text must be 1..2000 characters");
    if (claim.predicate !== undefined && !(PREDICATES as readonly string[]).includes(claim.predicate))
      throw fail(422, "bad_predicate", `predicate must be one of: ${PREDICATES.join(", ")}`);
    const st = claim.initialStatus ?? "observed";
    // Ingestion may only assert observed/inferred/assumed — never verified,
    // corroborated, disputed, withdrawn, or superseded (those need evidence
    // or human review through the assessment path).
    if (!["observed", "inferred", "assumed"].includes(st))
      throw fail(422, "bad_status", "ingestion may only assert observed, inferred, or assumed");
    if (!["A", "B", "C", "D"].includes(claim.reliability))
      throw fail(422, "bad_reliability", "reliability must be A-D");
    if (!Number.isInteger(claim.credibility) || claim.credibility < 1 || claim.credibility > 5)
      throw fail(422, "bad_credibility", "credibility must be 1-5");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const co = await client.query("select id from public.company where id = $1", [obs.companyId]);
    if (co.rows.length === 0) {
      await client.query("rollback");
      throw fail(404, "company_not_found", "company not found");
    }
    const so = await client.query("select key from public.source where key = $1", [obs.sourceKey]);
    if (so.rows.length === 0) {
      await client.query("rollback");
      throw fail(422, "unknown_source", "source key is not registered");
    }
    const sha = observationHash(obs.url, excerpt);
    const existing = await client.query(
      "select id from public.snapshot where company_id = $1 and sha256 = $2 limit 1",
      [obs.companyId, sha],
    );
    if (existing.rows.length > 0) {
      await client.query("commit");
      return { snapshotId: existing.rows[0].id as string, existed: true, claimId: null };
    }
    const s = await client.query(
      `insert into public.snapshot
         (company_id, source_key, url, sha256, store_ref, content_excerpt,
          retention_class, observed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        obs.companyId,
        obs.sourceKey,
        obs.url,
        sha,
        null,
        excerpt === "" ? null : excerpt,
        retention,
        obs.observedAt ?? null,
      ],
    );
    const snapshotId: string = s.rows[0].id;
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('snapshot', $1, $2, null, 'captured', $3)`,
      [snapshotId, obs.actor, `observation ingested from ${obs.sourceKey}`],
    );
    let claimId: string | null = null;
    if (claim) {
      const r = await client.query(
        `insert into public.claim
           (company_id, snapshot_id, claim_text, claim_status, source_reliability,
            info_credibility, observed_at, expires_at, predicate)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [
          obs.companyId,
          snapshotId,
          claimText,
          claim.initialStatus ?? "observed",
          claim.reliability,
          claim.credibility,
          obs.observedAt ?? null,
          claim.expiresAt ?? null,
          claim.predicate ?? null,
        ],
      );
      claimId = r.rows[0].id as string;
      await client.query(
        `insert into public.claim_assessment
           (claim_id, from_status, to_status, rationale, actor, automatic)
         values ($1, null, $2, $3, $4, false)`,
        [claimId, claim.initialStatus ?? "observed", "initial assertion at ingestion", obs.actor],
      );
      await client.query(
        `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
         values ('claim', $1, $2, null, $3, 'claim asserted at ingestion')`,
        [claimId, obs.actor, claim.initialStatus ?? "observed"],
      );
    }
    await client.query("commit");
    return { snapshotId, existed: false, claimId };
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

/** Attach supporting/contradicting/contextual evidence to a claim. */
export async function attachEvidence(
  pool: Pool,
  input: {
    claimId: string;
    snapshotId?: string;
    linkedClaimId?: string;
    polarity: "supports" | "contradicts" | "contextual";
    note?: string;
    actor: string;
  },
): Promise<{ id: string }> {
  if (!["supports", "contradicts", "contextual"].includes(input.polarity))
    throw fail(422, "bad_polarity", "polarity must be supports, contradicts, or contextual");
  if ((input.snapshotId ? 1 : 0) + (input.linkedClaimId ? 1 : 0) !== 1)
    throw fail(422, "bad_target", "exactly one of snapshotId, linkedClaimId is required");
  const client = await pool.connect();
  try {
    const c = await client.query("select id from public.claim where id = $1", [input.claimId]);
    if (c.rows.length === 0) throw fail(404, "claim_not_found", "claim not found");
    if (input.snapshotId) {
      const s = await client.query("select id from public.snapshot where id = $1", [input.snapshotId]);
      if (s.rows.length === 0) throw fail(404, "snapshot_not_found", "snapshot not found");
    }
    if (input.linkedClaimId) {
      if (input.linkedClaimId === input.claimId)
        throw fail(422, "self_link", "a claim cannot evidence itself");
      const l = await client.query("select id from public.claim where id = $1", [input.linkedClaimId]);
      if (l.rows.length === 0) throw fail(404, "claim_not_found", "linked claim not found");
    }
    const r = await client.query(
      `insert into public.claim_evidence
         (claim_id, snapshot_id, linked_claim_id, polarity, note, created_by)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        input.claimId,
        input.snapshotId ?? null,
        input.linkedClaimId ?? null,
        input.polarity,
        (input.note ?? "").slice(0, 2000) || null,
        input.actor,
      ],
    );
    await client.query(
      `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
       values ('claim', $1, $2, 'evidence', $3, $4)`,
      [input.claimId, input.actor, input.polarity, (input.note ?? "").slice(0, 500) || `${input.polarity} evidence attached`],
    );
    return { id: r.rows[0].id as string };
  } finally {
    client.release();
  }
}
