// Signal-source ingestion run (Phase 2). Companion to `run.ts`, which is
// GLEIF-specific: it CREATES companies and writes LEI identity claims. A
// hiring feed must do neither — it attaches dated signals to a company an
// operator has already resolved. Reusing `runDiscovery` would have fabricated
// identity claims ("LEI unknown") for every job posting, so this module owns
// its own, smaller flow.
//
// FLOW per run:
//   source permission gate -> resolve board token -> company -> run row ->
//   per record: (source_key, source_record_id) idempotency on content hash ->
//   ingestObservation (Phase 1) -> discovery_record row -> counts.
//
// IDENTITY (the reason this module exists): the source gives a board token,
// never a domain or registry id. The operator declares the link once
// (`linkBoardToken`); an unlinked token produces an `unresolved` run with ZERO
// records written. Nothing is auto-created and nothing is auto-merged.
//
// AMENDMENTS: a repeated run compares the content hash. Unchanged content is a
// `duplicate` (no writes). Changed content is an `amended` record — the
// evidence ledger is append-only, so the amendment is represented as a NEW
// snapshot+claim while the discovery_record row is updated to the new hash.
// Claim statuses are NOT auto-transitioned: staleness is a human assessment.
// ABSENCE IS NOT EVIDENCE: a posting that disappears from the board is not
// recorded as a closure, a withdrawal, or a negative signal.

import type { Pool } from "pg";
import { ingestObservation } from "../evidence/ingest";
import { observationHash } from "../evidence/hash";
import { assertSourceEnabled } from "./sources";
import type { AdapterRegistry } from "./registry";
import type { AdapterManifest, RawRecord } from "./types";
import type { HiringSignal } from "./adapters/greenhouse";

export const SIGNAL_SOURCE_KEY = "greenhouse-job-board";

const RUN_TIMEOUT_MS = 120_000;

export type SignalItemStatus =
  | "new"
  | "amended"
  | "duplicate"
  | "unresolved"
  | "skipped"
  | "invalid"
  | "failed";

export interface SignalItemResult {
  sourceRecordId: string;
  status: SignalItemStatus;
  companyId: string | null;
  claimId: string | null;
  warnings: string[];
  note: string | null;
}

export interface SignalRunCounts {
  found: number;
  new: number;
  amended: number;
  duplicates: number;
  unresolved: number;
  skipped: number;
  failed: number;
}

export interface SignalRunResult {
  runId: string | null;
  status: "ok" | "partial" | "empty" | "unresolved" | "failed" | "cancelled";
  companyId: string | null;
  counts: SignalRunCounts;
  items: SignalItemResult[];
  error: string | null;
}

export interface SignalRunOptions {
  adapterId: string;
  /** The source-specific query token (Greenhouse: the board token). */
  queryText: string;
  actor: string;
  limit?: number;
  maxPages?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Operator-declared identity link: board token -> company. This is the ONLY
 * way a Greenhouse record may be attached to a company, and it is explicit,
 * auditable, and repeatable (re-linking the same token updates the note).
 */
export async function linkBoardToken(
  pool: Pool,
  args: { companyId: string; boardToken: string; actor: string; note?: string },
): Promise<{ recordId: string; created: boolean }> {
  const token = args.boardToken.trim();
  if (token.length === 0 || token.length > 300)
    throw Object.assign(new Error("board token must be 1..300 characters"), {
      status: 422,
      code: "bad_board_token",
    });
  const co = await pool.query(
    "select id from public.company where id = $1 and merged_into is null",
    [args.companyId],
  );
  if (co.rows.length === 0)
    throw Object.assign(new Error("company not found (or merged)"), {
      status: 404,
      code: "company_not_found",
    });
  const existing = await pool.query(
    `select id, company_id from public.discovery_record
     where source_key = $1 and source_record_id = $2`,
    [SIGNAL_SOURCE_KEY, token],
  );
  if (existing.rows.length > 0) {
    if (existing.rows[0].company_id !== args.companyId) {
      // Never silently re-point a token at another company: that would be an
      // unrecorded identity decision.
      throw Object.assign(
        new Error("board token is already linked to a different company; resolve manually"),
        { status: 409, code: "board_token_conflict" },
      );
    }
    return { recordId: existing.rows[0].id as string, created: false };
  }
  const ins = await pool.query(
    `insert into public.discovery_record
       (company_id, source_key, source_record_id, source_url, collection_method,
        retrieval_status, query_text, adapter_version, note)
     values ($1, $2, $3, null, 'manual', 'ok', $4, null, $5) returning id`,
    [
      args.companyId,
      SIGNAL_SOURCE_KEY,
      token,
      token,
      args.note ?? `operator-declared board-token link to ${token}`,
    ],
  );
  await pool.query(
    `insert into public.audit_log (entity_type, entity_id, actor, transition_to, reason)
     values ('discovery_record', $1, $2, 'linked', $3)`,
    [ins.rows[0].id, args.actor, `board token ${token} linked to company by operator`],
  );
  return { recordId: ins.rows[0].id as string, created: true };
}

/** Resolve a board token to its linked company. Explicitly nullable. */
export async function resolveLinkedCompany(
  pool: Pool,
  sourceKey: string,
  token: string,
): Promise<{ companyId: string | null; ambiguous: boolean }> {
  const rows = await pool.query(
    `select distinct company_id from public.discovery_record
     where source_key = $1 and source_record_id = $2`,
    [sourceKey, token],
  );
  const ids = [...new Set(rows.rows.map((r) => r.company_id as string))];
  if (ids.length === 0) return { companyId: null, ambiguous: false };
  if (ids.length > 1) return { companyId: null, ambiguous: true };
  return { companyId: ids[0], ambiguous: false };
}

/** Factual, personal-data-free extract of one posting. */
function excerptFor(s: HiringSignal): string {
  return [
    `Greenhouse job ${s.jobId}: "${s.title}"`,
    s.location ? `location ${s.location}` : "location not stated by source",
    s.requisitionId ? `requisition ${s.requisitionId}` : "requisition id not stated",
    `board ${s.boardToken}`,
    s.publishedAt ? `first_published ${s.publishedAt}` : "first_published not stated",
    s.updatedAt ? `updated_at ${s.updatedAt}` : "updated_at not stated",
  ].join(" | ");
}

export async function runSignalSource(
  pool: Pool,
  registry: AdapterRegistry,
  opts: SignalRunOptions,
): Promise<SignalRunResult> {
  const manifest: AdapterManifest = registry.get(opts.adapterId).manifest();
  const sourceKey = manifest.sourceKey ?? SIGNAL_SOURCE_KEY;
  const token = (opts.queryText ?? "").trim();
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
  const maxPages = Math.min(Math.max(opts.maxPages ?? 3, 1), 3);
  const counts: SignalRunCounts = {
    found: 0, new: 0, amended: 0, duplicates: 0, unresolved: 0, skipped: 0, failed: 0,
  };
  const items: SignalItemResult[] = [];
  const fail = (status: SignalRunResult["status"], error: string, runId: string | null = null): SignalRunResult => ({
    runId, status, companyId: null, counts: { ...counts }, items, error,
  });

  // Gate FIRST: a disabled or unknown source leaves no run row, no fetch, no
  // writes at all.
  try {
    await assertSourceEnabled(pool, sourceKey);
  } catch (e: unknown) {
    const err = e as { status?: number; code?: string; message?: string };
    return fail("failed", `${err.code ?? "source_refused"}: ${err.message ?? "source not permitted"}`);
  }
  if (token.length === 0 || token.length > 300)
    return fail("failed", "bad_query: query token must be 1..300 characters");

  // Identity BEFORE any fetch: an unlinked token must not cost a network call.
  const link = await resolveLinkedCompany(pool, sourceKey, token);
  if (link.companyId === null) {
    return fail(
      "unresolved",
      link.ambiguous
        ? `board token '${token}' is linked to more than one company; resolve manually`
        : `board token '${token}' has no company link — declare one (linkBoardToken) before ingesting signals`,
    );
  }
  const companyId = link.companyId;

  const started = await pool.query(
    `insert into public.discovery_run
       (adapter_id, adapter_version, status, query_text, created_by)
     values ($1, $2, 'running', $3, $4) returning id`,
    [manifest.id, manifest.version, token, opts.actor],
  );
  const runId: string = started.rows[0].id;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("run timeout")), RUN_TIMEOUT_MS);
  const onAbort = () => ctrl.abort(opts.signal?.reason ?? new Error("cancelled"));
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const done = async (status: SignalRunResult["status"], error: string | null): Promise<SignalRunResult> => {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    // discovery_run.status is a closed vocabulary that has no 'empty' or
    // 'unresolved' member. A run that found nothing is recorded as 'ok' with a
    // zero count (error carries the reason); inventing new CHECK values would
    // widen a contract other consumers already rely on.
    const persisted =
      status === "empty" ? "ok" : status === "unresolved" ? "failed" : status;
    await pool.query(
      `update public.discovery_run set status = $2, finished_at = now(),
         found = $3, created_new = $4, duplicates = $5, skipped = $6,
         conflicts = $7, failed_items = $8, error = $9 where id = $1`,
      [
        runId, persisted, counts.found, counts.new, counts.duplicates, counts.skipped,
        counts.unresolved, counts.failed, error,
      ],
    );
    return { runId, status, companyId, counts: { ...counts }, items, error };
  };

  const adapter = registry.get(opts.adapterId);
  let pageToken: string | undefined;
  let exhausted = true;
  let anyRecords = false;

  try {
    for (let page = 0; page < maxPages; page++) {
      let outcome;
      try {
        outcome = await registry.discover(
          opts.adapterId,
          { text: token, limit, pageToken },
          {},
          { signal: ctrl.signal, timeoutMs: opts.timeoutMs ?? 30_000 },
        );
      } catch (e: unknown) {
        const msg =
          (e as { registryError?: { message?: string } }).registryError?.message ??
          "registry invocation failed";
        return await done("failed", msg);
      }
      if (outcome.kind === "failed") {
        if (outcome.cause === "cancelled") return await done("cancelled", outcome.message);
        return await done("failed", `${outcome.cause}: ${outcome.message}`);
      }
      if (outcome.kind === "empty") break;
      for (const raw of outcome.records) {
        counts.found += 1;
        await processRecord(raw);
      }
      anyRecords = anyRecords || outcome.records.length > 0;
      if (!outcome.page.nextPageToken) break;
      pageToken = outcome.page.nextPageToken;
      if (page === maxPages - 1) exhausted = false;
    }
    if (!anyRecords) return await done("empty", null);
    return await done(exhausted ? "ok" : "partial", null);
  } catch (e: unknown) {
    return await done("failed", e instanceof Error ? e.message : "run crashed");
  }

  async function processRecord(raw: RawRecord): Promise<void> {
    const sid = (raw.sourceRecordId ?? "").trim();
    if (sid.length === 0 || sid.length > 300) {
      counts.skipped += 1;
      items.push({
        sourceRecordId: sid || "unknown", status: "skipped", companyId, claimId: null,
        warnings: [], note: "record has no usable source id; cannot ensure idempotency",
      });
      return;
    }
    // The typed normalizer is adapter-specific; guard the contract.
    const normalizeJob = (adapter as { normalizeJob?: (r: RawRecord) => HiringSignal | null }).normalizeJob;
    const signal = normalizeJob ? normalizeJob(raw) : null;
    if (!signal) {
      counts.failed += 1;
      items.push({
        sourceRecordId: sid, status: "failed", companyId, claimId: null,
        warnings: [], note: "record did not normalize into a hiring signal",
      });
      return;
    }

    const excerpt = excerptFor(signal);
    const sha = observationHash(signal.canonicalUrl, excerpt);
    const seen = await pool.query(
      `select id, source_url, retrieval_status, note from public.discovery_record
       where source_key = $1 and source_record_id = $2 limit 1`,
      [sourceKey, sid],
    );
    const isAmendment = seen.rows.length > 0 && seen.rows[0].note !== `sha256:${sha}`;
    if (seen.rows.length > 0 && !isAmendment) {
      counts.duplicates += 1;
      items.push({
        sourceRecordId: sid, status: "duplicate", companyId, claimId: null,
        warnings: [], note: "source record already ingested with identical content",
      });
      return;
    }

    try {
      const obs = await ingestObservation(
        pool,
        {
          companyId,
          sourceKey,
          url: signal.canonicalUrl,
          excerpt,
          // observed_at carries the SOURCE-stated record-modification time, not
          // our ingestion time (fetched_at already records that).
          observedAt: signal.updatedAt ?? undefined,
          retentionClass: "page",
          actor: opts.actor,
        },
        {
          predicate: "hiring",
          text:
            `Job posting "${signal.title}"` +
            (signal.location ? ` in ${signal.location}` : " (location not stated by source)") +
            ` (Greenhouse board ${signal.boardToken}, job ${signal.jobId}). ` +
            "Evidence of an open requisition only; not evidence of intent to subcontract.",
          initialStatus: "observed",
          // Reliability: employer-authored first-party content, delivered via a
          // vendor platform. Credibility: high that a posting exists, low about
          // what it implies commercially.
          reliability: "B",
          credibility: 2,
          publishedAt: signal.publishedAt ?? undefined,
        },
      );

      if (isAmendment) {
        // Target by primary key (already read above) so every parameter is
        // referenced; an unused placeholder would leave Postgres unable to
        // infer its type.
        await pool.query(
          `update public.discovery_record
             set source_url = $2, retrieved_at = now(), retrieval_status = 'ok',
                 query_text = $3, note = $4
           where id = $1`,
          [seen.rows[0].id, signal.canonicalUrl, token, `sha256:${sha}`],
        );
        await pool.query(
          `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
           values ('discovery_record', $1, $2, 'observed', 'amended', $3)`,
          [seen.rows[0].id, opts.actor, `source content changed for ${sid}; evidence ledger appended`],
        );
        counts.amended += 1;
        items.push({
          sourceRecordId: sid, status: "amended", companyId, claimId: obs.claimId,
          warnings: signal.warnings, note: "content changed since last run; appended as a new observation",
        });
        return;
      }

      // Plain INSERT, no ON CONFLICT: the existing unique index
      // discovery_record_source_uidx is PARTIAL (WHERE source_key IS NOT NULL
      // AND source_record_id IS NOT NULL), and Postgres cannot infer a partial
      // index from an inference clause without repeating that predicate. The
      // 23505 case below is therefore handled explicitly.
      let inserted = true;
      try {
        await pool.query(
          `insert into public.discovery_record
             (company_id, source_key, source_record_id, source_url, collection_method,
              retrieval_status, query_text, adapter_version, note)
           values ($1, $2, $3, $4, 'api', 'ok', $5, $6, $7)`,
          [companyId, sourceKey, sid, signal.canonicalUrl, token, manifest.version, `sha256:${sha}`],
        );
      } catch (e: unknown) {
        if ((e as { code?: string }).code !== "23505") throw e;
        inserted = false;
      }
      if (!inserted || obs.existed) {
        // The ledger already held this exact observation (it was recorded
        // manually first, or a concurrent run won the race). Nothing
        // duplicated; reported honestly as a duplicate.
        counts.duplicates += 1;
        items.push({
          sourceRecordId: sid, status: "duplicate", companyId, claimId: obs.claimId,
          warnings: signal.warnings,
          note: obs.existed
            ? "observation already existed in the evidence ledger"
            : "source record already persisted by a concurrent run",
        });
        return;
      }
      counts.new += 1;
      items.push({
        sourceRecordId: sid, status: "new", companyId, claimId: obs.claimId,
        warnings: signal.warnings, note: null,
      });
    } catch (e: unknown) {
      counts.failed += 1;
      items.push({
        sourceRecordId: sid, status: "failed", companyId, claimId: null,
        warnings: signal.warnings, note: e instanceof Error ? e.message : "persistence failed",
      });
    }
  }
}