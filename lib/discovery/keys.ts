// Discovery opportunity keys (Prompt 4, blueprint §2/§3). Pure derivation,
// no I/O: fully unit-testable. Stable per-pipeline identity so reposts and
// cross-run sightings resolve deterministically (amendment §4E).

export type OpportunityPipeline = "agency_partner" | "direct_client";

export interface OpportunityKeyInput {
  pipeline: OpportunityPipeline;
  /** Adapter source key (e.g. "gleif-api") or "manual". */
  sourceKey: string;
  /** Stable per-source record id; null when the record has none. */
  sourceRecordId: string | null;
  /** Fallback identity material when no stable record id exists. */
  fallback?: string;
}

function canon(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

/**
 * Canonical opportunity key. Adapter records: opp:<pipeline>:<source>:<id>.
 * Records without a stable id (manual observations): opp:<pipeline>:manual:
 * <canonicalized fallback>. Empty source keys/ids never produce a key —
 * callers must route such records to review/skip, never invent identity.
 */
export function opportunityKey(input: OpportunityKeyInput): string {
  const pipeline = input.pipeline;
  if (pipeline !== "agency_partner" && pipeline !== "direct_client") {
    throw fail(422, "bad_pipeline", "pipeline must be agency_partner or direct_client");
  }
  const source = canon(input.sourceKey);
  if (!source) throw fail(422, "bad_source", "source key is required for opportunity identity");
  const rid = (input.sourceRecordId ?? "").trim();
  if (rid) {
    if (rid.length > 300) throw fail(422, "bad_record_id", "source record id exceeds 300 characters");
    return `opp:${pipeline}:${source}:${rid.toLowerCase()}`;
  }
  const fb = canon(input.fallback ?? "");
  if (!fb) {
    throw fail(
      422,
      "no_stable_identity",
      "record has no stable source id and no fallback identity — route to review, do not invent a key",
    );
  }
  return `opp:${pipeline}:${source}:manual:${fb}`;
}

/** Repost check: identical content hashes resolve to the same key by construction. */
export function contentFingerprint(text: string): string {
  return canon(text).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 200);
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
