// Discovery-run orchestration (T-006). Synchronous, bounded, resumability-free.
//
// FLOW per run: create run row (running) -> page through the adapter (at most
// maxPages) -> per record: idempotency check -> intake validation ->
// create-or-conflict (409 runs T-004 resolution, NEVER auto-merges here) ->
// persist item row -> finish run with counts. Each record commits in its own
// transaction (createCompany); a mid-run crash leaves the run `running`
// (documented limitation: no resume; rerunning is idempotent via stable
// source-record identity).
// Companies are never updated by discovery — only created or queued.

import type { Pool } from "pg";
import { createCompany } from "../intake/import";
import { validateCompanyInput } from "../intake/validate";
import { findCandidates } from "../resolve/engine";
import { recordIdentityConflict } from "../resolve/conflicts";
import type { ConflictRule } from "../resolve/conflicts";
import { ingestObservation } from "../evidence/ingest";
import type { AdapterRegistry } from "./registry";
import { assertSourceEnabled } from "./sources";
import type { NormalizedDiscovery, RawRecord } from "./types";

export const SOURCE_KEY = "gleif-api";

export interface RunOptions {
  adapterId: string;
  queryText: string;
  limit?: number;
  maxPages?: number;
  actor: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RunItemResult {
  sourceRecordId: string;
  status: "new" | "duplicate" | "skipped" | "invalid" | "conflict" | "failed";
  companyId: string | null;
  candidateId: string | null;
  warnings: string[];
  note: string | null;
}

export interface RunCounts {
  found: number;
  new: number;
  duplicates: number;
  skipped: number;
  conflicts: number;
  failed: number;
}

export interface RunResult {
  runId: string;
  status: string;
  counts: RunCounts;
  items: RunItemResult[];
  error: string | null;
}

const RUN_TIMEOUT_MS = 120_000;

function toIntakeInput(n: NormalizedDiscovery) {
  return {
    name: n.name,
    domain: n.domain ?? "",
    registryId: n.registryId ?? "",
    registryType: n.registryType ?? "",
    agencyType: n.agencyType,
    country: n.country,
    countryCode: n.countryCode ?? "",
    region: n.region ?? "",
    websiteUrl: n.websiteUrl ?? "",
  };
}

export async function runDiscovery(
  pool: Pool,
  registry: AdapterRegistry,
  opts: RunOptions,
): Promise<RunResult> {
  const text = (opts.queryText ?? "").trim();
  if (text.length < 1 || text.length > 200) {
    const e = new Error("query text must be 1..200 characters") as Error & {
      status: number;
      code: string;
    };
    e.status = 422;
    e.code = "bad_query";
    throw e;
  }
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  const maxPages = Math.min(Math.max(opts.maxPages ?? 3, 1), 3);

  const manifest = registry.get(opts.adapterId).manifest();
  // B-D5 / amendment §4F: the source registry is the permission gate. Refuse
  // BEFORE any write so a disabled-source run leaves no partial history.
  const sourceKey = manifest.sourceKey ?? SOURCE_KEY;
  await assertSourceEnabled(pool, sourceKey);
  const started = await pool.query(
    `insert into public.discovery_run
       (adapter_id, adapter_version, status, query_text, created_by)
     values ($1, $2, 'running', $3, $4) returning id`,
    [manifest.id, manifest.version, text, opts.actor],
  );
  const runId: string = started.rows[0].id;

  const counts: RunCounts = {
    found: 0, new: 0, duplicates: 0, skipped: 0, conflicts: 0, failed: 0,
  };

  const finish = async (status: string, error: string | null): Promise<RunResult> => {
    await pool.query(
      `update public.discovery_run set status = $2, finished_at = now(),
         found = $3, created_new = $4, duplicates = $5, skipped = $6,
         conflicts = $7, failed_items = $8, error = $9 where id = $1`,
      [
        runId, status, counts.found, counts.new, counts.duplicates,
        counts.skipped, counts.conflicts, counts.failed, error,
      ],
    );
    // Map to the DECLARED RunItemResult shape. A bare `as RunItemResult[]`
    // cast on pg rows is a lie: pg returns snake_case, so every consumer
    // reading companyId/sourceRecordId saw undefined. Silent-data-loss class
    // of bug - the type is the contract, so the mapping is explicit.
    const items = (
      await pool.query(
        `select source_record_id, status, company_id, candidate_id, warnings, note
         from public.discovery_run_item where run_id = $1 order by created_at`,
        [runId],
      )
    ).rows.map((r) => ({
      sourceRecordId: r.source_record_id as string,
      status: r.status as RunItemResult["status"],
      companyId: (r.company_id as string | null) ?? null,
      candidateId: (r.candidate_id as string | null) ?? null,
      warnings: (r.warnings as string[]) ?? [],
      note: (r.note as string | null) ?? null,
    } satisfies RunItemResult));
    return { runId, status, counts: { ...counts }, items, error };
  };

  const recordItem = async (
    sourceRecordId: string,
    status: RunItemResult["status"],
    extra: {
      companyId?: string | null;
      candidateId?: string | null;
      warnings?: string[];
      note?: string | null;
    } = {},
  ): Promise<void> => {
    await pool.query(
      `insert into public.discovery_run_item
         (run_id, source_record_id, status, company_id, candidate_id, warnings, note)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (run_id, source_record_id) do nothing`,
      [
        runId, sourceRecordId, status,
        extra.companyId ?? null, extra.candidateId ?? null,
        JSON.stringify((extra.warnings ?? []).slice(0, 20)),
        extra.note ?? null,
      ],
    );
    if (status === "new") counts.new += 1;
    else if (status === "duplicate") counts.duplicates += 1;
    else if (status === "skipped" || status === "invalid") counts.skipped += 1;
    else if (status === "conflict") counts.conflicts += 1;
    else if (status === "failed") counts.failed += 1;
  };

  // Overall run timeout + caller cancellation combined.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("run timeout")), RUN_TIMEOUT_MS);
  const onAbort = () => ctrl.abort(opts.signal?.reason ?? new Error("cancelled"));
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const done = async (status: string, error: string | null): Promise<RunResult> => {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    return finish(status, error);
  };

  const adapter = registry.get(opts.adapterId);

  try {
    let pageToken: string | undefined;
    let exhaustedPages = true;
    for (let page = 0; page < maxPages; page++) {
      let outcome;
      try {
        outcome = await registry.discover(
          opts.adapterId,
          { text, limit, pageToken },
          {},
          { signal: ctrl.signal, timeoutMs: opts.timeoutMs ?? 30_000 },
        );
      } catch (e: unknown) {
        const msg =
          (e as { registryError?: { message?: string } }).registryError?.message ??
          "registry invocation failed";
        return done("failed", msg);
      }
      if (outcome.kind === "failed") {
        if (outcome.cause === "cancelled") return done("cancelled", outcome.message);
        return done("failed", `${outcome.cause}: ${outcome.message}`);
      }
      if (outcome.kind === "empty") break;
      for (const raw of outcome.records) {
        counts.found += 1;
        await processRecord(raw);
      }
      if (!outcome.page.nextPageToken) break;
      pageToken = outcome.page.nextPageToken;
      if (page === maxPages - 1) exhaustedPages = false;
    }
    return done(exhaustedPages ? "ok" : "partial", null);
  } catch (e: unknown) {
    return done("failed", e instanceof Error ? e.message : "run crashed");
  }

  async function processRecord(raw: RawRecord): Promise<void> {
    const sid = (raw.sourceRecordId ?? "").trim() || "unknown";
    if (sid === "unknown") {
      await recordItem("unknown", "skipped", {
        warnings: [],
        note: "record has no stable source id; cannot ensure idempotency",
      });
      return;
    }
    // Idempotency: stable (source, record) identity seen before?
    const seen = await pool.query(
      `select company_id from public.discovery_record
       where source_key = $1 and source_record_id = $2 limit 1`,
      [sourceKey, sid],
    );
    if (seen.rows.length > 0) {
      await recordItem(sid, "duplicate", {
        companyId: seen.rows[0].company_id as string,
        note: "source record already processed",
      });
      return;
    }
    let normalized: NormalizedDiscovery;
    try {
      normalized = adapter.normalize(raw, manifest);
    } catch {
      await recordItem(sid, "failed", { note: "normalization failed" });
      return;
    }
    const v = validateCompanyInput(toIntakeInput(normalized));
    if (!v.ok) {
      await recordItem(sid, "invalid", {
        warnings: normalized.warnings,
        note: v.errors.map((e) => `${e.field}: ${e.message}`).join("; "),
      });
      return;
    }
    try {
      const created = await createCompany(pool, toIntakeInput(normalized), opts.actor, {
        sourceKey,
        collectionMethod: "api",
        sourceRecordId: sid,
        note: `discovery run ${runId} (${manifest.id} v${manifest.version})`,
        auditReason: `discovery run ${runId}`,
      });
      // GLEIF observations support identity claims (registry fields only —
      // never agency services or operational problems). Best-effort: the
      // company stands even if observation capture fails (noted below).
      let obsNote: string | null = null;
      if (normalized.sourceUrl) {
        try {
          await ingestObservation(
            pool,
            {
              companyId: created.companyId,
              sourceKey,
              url: normalized.sourceUrl,
              excerpt: [
                `LEI ${normalized.registryId ?? "unknown"}: ${normalized.name}`,
                `(${normalized.country})`,
              ].join(" "),
              retentionClass: "registry",
              actor: opts.actor,
            },
            normalized.registryId
              ? {
                  predicate: "identity",
                  text: `Recorded as "${normalized.name}" under LEI ${normalized.registryId} (${normalized.country})`,
                  initialStatus: "observed",
                  reliability: "A",
                  credibility: 2,
                }
              : undefined,
          );
        } catch {
          obsNote = "company created; observation capture failed (see run error log)";
        }
      }
      await recordItem(sid, "new", {
        companyId: created.companyId,
        warnings: normalized.warnings,
        note: obsNote,
      });
    } catch (e: unknown) {
      const code = (e as { status?: number; code?: string }).code;
      const status = (e as { status?: number }).status;
      if (status === 409) {
        // Canonical unique hit: route through identity resolution (review).
        try {
          const res = await findCandidatesByIdentity(normalized, sid);
          await recordItem(sid, "conflict", {
            candidateId: res.candidateId,
            warnings: normalized.warnings,
            note: res.note,
          });
        } catch (inner: unknown) {
          await recordItem(sid, "failed", {
            note: inner instanceof Error ? inner.message : "resolution failed",
          });
        }
        void code;
      } else if (status === 422) {
        await recordItem(sid, "invalid", {
          warnings: normalized.warnings,
          note: (e as Error).message,
        });
      } else {
        await recordItem(sid, "failed", {
          note: e instanceof Error ? e.message : "persistence failed",
        });
      }
    }
  }

  async function findCandidatesByIdentity(
    n: NormalizedDiscovery,
    sourceRecordId: string,
  ): Promise<{ candidateId: string | null; note: string }> {
    // Locate the conflicting canonical record deterministically, then CAPTURE
    // what the source claimed as an identity_conflict review row (M7).
    //
    // Why not findCandidates: the conflicting entity must not exist as a
    // company (creating it would pre-decide a merge, D-011), and match_candidate
    // needs two company rows. Asking for candidates of the existing record
    // therefore finds nothing - which silently dropped the observation's
    // identity attributes. Zero merge semantics either way: nothing here writes
    // merged_into.
    const hit = await pool.query(
      `select id from public.company where merged_into is null and (
         ($1::text is not null and domain_norm = $1) or
         ($2::text is not null and $3::text is not null
          and registry_id = $2 and country_code = $3)
       ) limit 1`,
      [n.domain ?? null, n.registryId ?? null, n.countryCode ?? null],
    );
    if (hit.rows.length === 0)
      return { candidateId: null, note: "conflicts with an existing record (not located)" };
    const registryScoped =
      (n.registryId ?? "").length > 0 && (n.countryCode ?? "").length > 0;
    const rule: ConflictRule = registryScoped ? "registry_scoped" : "domain_exact";
    const detail = registryScoped
      ? `registry ${n.registryId} already registered for ${n.countryCode} under a different record`
      : `domain ${n.domain ?? "unknown"} already registered under a different record`;
    const { conflict, created } = await recordIdentityConflict(pool, {
      runId,
      sourceRecordId,
      companyId: hit.rows[0].id as string,
      rule,
      detail,
      observedName: n.name,
      observedDomain: n.domain ?? null,
      observedRegistryId: n.registryId ?? null,
      observedCountryCode: n.countryCode ?? null,
    });
    return {
      // candidate_id stays NULL on purpose: it references match_candidate, and
      // this is not one. The conflict id is reported in the note.
      candidateId: null,
      note:
        `identity conflict ${conflict.id} (${rule}) recorded for human review` +
        (created ? "" : " — already captured for this record") +
        `: ${detail}`,
    };
  }
}
