// Greenhouse Job Board API adapter (Phase 2). Second real discovery source;
// the first SOURCE THAT PRODUCES DATED SIGNALS ABOUT A KNOWN COMPANY.
//
// ACCESS (verified 2026-10-16 against official docs + one live read-only
// probe — see docs/P2_SOURCE_SELECTION.md):
//   base   https://boards-api.greenhouse.io/v1/boards/{board_token}
//   GET /jobs            keyless, no registration ("authentication is not
//                         required for any GET endpoints")
//   GET /boards/{token}  keyless, returns the org display name
//   Only the application-submission POST needs Basic Auth — never used here.
//   Rate limits: NONE published for the Job Board API (the documented limits
//   belong to Harvest, a different, authenticated API). Mitigation is bounded
//   runs + backoff on 429 honouring Retry-After.
//   Verified response shape (live, Greenhouse's own board, 17 jobs): top-level
//   {jobs:[], meta:{total}}; job keys absolute_url, application_deadline,
//   company_name, data_compliance, first_published, id, internal_job_id,
//   language, location{name}, metadata, requisition_id, title, updated_at.
//
// IDENTITY: the API is per-tenant. A job id is only unique WITHIN one board,
// so the deterministic record id is `${boardToken}:${jobId}` — never the bare
// job id, which would collide across tenants. The API exposes NO company
// domain, registry id, or country code; `company_name` is a free-text label,
// not identity proof. This adapter therefore NEVER creates or merges a
// company: the operator links board token -> company first, and an unlinked
// token resolves to `unresolved` rather than being auto-assigned.
//
// SIGNALS, NOT PROOF: an open requisition is evidence that a company is
// hiring for a stated role. It is NOT evidence of intent to subcontract,
// dissatisfaction with an incumbent, or any internal problem. Every claim
// this adapter produces says so.

import { fetchJson, sleepAbortable, type FetchImpl } from "../http";
import type {
  AdapterConfig,
  AdapterManifest,
  ConfigValidation,
  DiscoveryOutcome,
  DiscoveryQuery,
  HealthReport,
  NormalizedDiscovery,
  Provenance,
  RawRecord,
  SourceAdapter,
} from "../types";

export const GREENHOUSE_ADAPTER_ID = "greenhouse-job-board";
export const GREENHOUSE_ADAPTER_VERSION = "0.1.0";

/** The single approved host this adapter may ever contact. */
export const GREENHOUSE_API_HOST = "boards-api.greenhouse.io";
const GREENHOUSE_BASE = `https://${GREENHOUSE_API_HOST}/v1/boards`;
const MAX_RETRIES = 2;
/** Board tokens are the public job-board path segment (e.g. "greenhouse"). */
const BOARD_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isBoardToken(value: string): boolean {
  return BOARD_TOKEN.test(value.trim());
}

/** Deterministic, tenant-scoped record id. */
export function jobRecordId(boardToken: string, jobId: string | number): string {
  return `${boardToken}:${String(jobId)}`;
}

interface Deps {
  fetchImpl?: FetchImpl;
}

/**
 * A hiring signal extracted from one job posting. Dates are the SOURCE's own
 * timestamps and are kept separate; each stays null when absent — never
 * defaulted to retrieval time or to each other.
 */
export interface HiringSignal {
  boardToken: string;
  jobId: string;
  title: string;
  location: string | null;
  requisitionId: string | null;
  canonicalUrl: string;
  /** Source-stated first publication of the posting, when present. */
  publishedAt: string | null;
  /** Source-stated last modification of the record, when present. */
  updatedAt: string | null;
  /** Fields the source did not supply, named explicitly. */
  missingFields: string[];
  warnings: string[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Field-length ceilings. Source values are data, never trusted at any size. */
const TITLE_MAX = 300;
const REQUISITION_MAX = 64;
const LOCATION_MAX = 200;

/** Parse a source timestamp, returning null (never a default) when unusable. */
function ts(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function parseJobPayload(payload: Record<string, unknown>, boardToken: string): HiringSignal | null {
  const id = payload["id"];
  if (typeof id !== "number" && typeof id !== "string") return null;
  const jobId = String(id);
  if (jobId.length === 0 || jobId.length > 60) return null;
  const title = str(payload["title"]);
  if (!title) return null;
  // An implausibly long title means the record is not a normal posting; drop
  // it rather than truncating (which would fabricate a different job).
  if (title.length > TITLE_MAX) return null;

  const locationObj = (payload["location"] ?? {}) as Record<string, unknown>;
  const rawLocation = str(locationObj["name"]) ?? null;
  const location = rawLocation !== null && rawLocation.length > LOCATION_MAX ? null : rawLocation;
  const rawRequisition = str(payload["requisition_id"]) ?? null;
  const requisitionId =
    rawRequisition !== null && rawRequisition.length > REQUISITION_MAX ? null : rawRequisition;
  // absolute_url is the human-facing posting page (provenance only, NEVER
  // fetched by this adapter — it lives on a different host).
  const absolute = str(payload["absolute_url"]);
  const canonicalUrl =
    absolute && absolute.startsWith("https://")
      ? absolute
      : `https://${GREENHOUSE_API_HOST}/v1/boards/${boardToken}/jobs/${encodeURIComponent(jobId)}`;

  const missingFields: string[] = [];
  if (!location) missingFields.push("location");
  if (!requisitionId) missingFields.push("requisition_id");
  const publishedAt = ts(payload["first_published"]);
  if (publishedAt === null) missingFields.push("first_published");
  const updatedAt = ts(payload["updated_at"]);
  if (updatedAt === null) missingFields.push("updated_at");
  if (!absolute) missingFields.push("absolute_url");

  const warnings = [
    "job posting is a hiring signal, not proof of subcontract intent or of any internal problem",
    "Greenhouse exposes no company domain, registry id or country code; identity comes from the operator-declared board-token link",
  ];
  return {
    boardToken,
    jobId,
    title,
    location,
    requisitionId,
    canonicalUrl,
    publishedAt,
    updatedAt,
    missingFields,
    warnings,
  };
}

export class GreenhouseAdapter implements SourceAdapter {
  private readonly fetchImpl?: FetchImpl;

  constructor(deps: Deps = {}) {
    this.fetchImpl = deps.fetchImpl;
  }

  manifest(): AdapterManifest {
    return {
      id: GREENHOUSE_ADAPTER_ID,
      name: "Greenhouse Job Board API",
      version: GREENHOUSE_ADAPTER_VERSION,
      category: "S-07",
      // Source registry row seeded DISABLED by the Phase 2 migration.
      // `source.enabled` gates every run; activation additionally requires the
      // recorded licensing decision (docs/P2_SOURCE_SELECTION.md §5).
      sourceKey: "greenhouse-job-board",
      capabilities: ["discover", "health"],
      limitations: [
        "job ids are tenant-scoped; records are keyed `${boardToken}:${jobId}`",
        "no pagination parameter exists — the list endpoint returns the whole board, so this adapter pages locally and re-fetches per page",
        "no company domain, registry id, or country code is exposed; country is never derived from office strings",
        "company identity requires an operator-declared board-token link; unlinked tokens stay unresolved",
        "`content=true` is deliberately NOT requested: it inflates responses (~12 KB of HTML per job) and adds untrusted markup this product must not store",
        "job `metadata` custom fields are never copied into evidence (untrusted, may carry personal data)",
        "only employers on Greenhouse are visible; worldwide coverage depends on each company's ATS choice",
        "a posting is a hiring signal only — never proof of intent to subcontract",
      ],
      accessRequirements:
        "none — public keyless Job Board API, no key and no registration (verified 2026-10-16)",
      maxPageSize: 100,
    };
  }

  validateConfig(config: AdapterConfig): ConfigValidation {
    const c = (config ?? {}) as Record<string, unknown>;
    const problems: { field: string; message: string }[] = [];
    for (const k of Object.keys(c))
      problems.push({
        field: k,
        message: "unknown option (this adapter takes no configuration; no credentials exist)",
      });
    return problems.length > 0 ? { ok: false, problems } : { ok: true };
  }

  private async get(
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<
    | { ok: true; json: unknown }
    | { ok: false; cancelled: true }
    | {
        ok: false;
        retry: boolean;
        cause: "rate_limited" | "network" | "terms_block" | "misconfigured" | "parse";
        message: string;
        retryAfterSec?: number;
      }
  > {
    const r = await fetchJson(url, { signal, fetchImpl: this.fetchImpl });
    if (r.ok) return { ok: true, json: r.json };
    switch (r.kind) {
      case "cancelled":
        return { ok: false, cancelled: true as const };
      case "network":
        return { ok: false, retry: true, cause: "network", message: r.message };
      case "redirect_blocked":
        // A cross-host or private-destination redirect from the API host is a
        // transport-integrity failure, not a licence question.
        return { ok: false, retry: false, cause: "terms_block", message: r.message };
      case "too_large":
      case "bad_content_type":
        return { ok: false, retry: false, cause: "parse", message: r.message };
      case "http": {
        const s = r.status ?? 0;
        // 404 with an EMPTY body is how Greenhouse reports an unknown board
        // token — a permanent, non-retryable configuration error.
        if (s === 404)
          return {
            ok: false,
            retry: false,
            cause: "misconfigured",
            message: "board token not found (404) — verify the token and that the board is public",
          };
        if (s === 429)
          return {
            ok: false,
            retry: true,
            cause: "rate_limited",
            message: "source rate limit (429)",
            ...(r.retryAfterSec === undefined ? {} : { retryAfterSec: r.retryAfterSec }),
          };
        if (s === 401 || s === 403)
          return {
            ok: false,
            retry: false,
            cause: "terms_block",
            message: `source refuses this access (${s})`,
          };
        if (s >= 500)
          return { ok: false, retry: true, cause: "network", message: r.message };
        return { ok: false, retry: false, cause: "misconfigured", message: r.message };
      }
    }
  }

  async discover(
    query: DiscoveryQuery,
    ctx: { config: AdapterConfig; signal?: AbortSignal },
  ): Promise<DiscoveryOutcome> {
    if (ctx.signal?.aborted)
      return { kind: "failed", cause: "cancelled", message: "cancelled before start", retryable: false };
    // The query text IS the board token: this API has no search operation, so
    // an arbitrary query string is a configuration error, not a zero-result
    // search.
    const board = (query.text ?? "").trim();
    if (!isBoardToken(board))
      return {
        kind: "failed",
        cause: "misconfigured",
        message:
          "query text must be a Greenhouse board token (letters, digits, hyphen, underscore; <= 64 chars) — this API has no search operation",
        retryable: false,
      };

    const url = `${GREENHOUSE_BASE}/${encodeURIComponent(board)}/jobs`;
    let attempt = 0;
    for (;;) {
      const r = await this.get(url, ctx.signal);
      if (r.ok) return this.toOutcome(r.json, board, query.limit ?? this.manifest().maxPageSize, query.pageToken);
      if ("cancelled" in r)
        return { kind: "failed", cause: "cancelled", message: "cancelled during run", retryable: false };
      if (!r.retry || attempt >= MAX_RETRIES)
        return { kind: "failed", cause: r.cause, message: r.message, retryable: r.retry };
      attempt += 1;
      const backoff = r.retryAfterSec ? r.retryAfterSec * 1000 : attempt === 1 ? 500 : 1500;
      if (await sleepAbortable(backoff, ctx.signal))
        return { kind: "failed", cause: "cancelled", message: "cancelled during backoff", retryable: false };
    }
  }

  private toOutcome(json: unknown, board: string, limit: number, pageToken?: string): DiscoveryOutcome {
    const doc = (json ?? {}) as Record<string, unknown>;
    const jobs = doc["jobs"];
    if (!Array.isArray(jobs))
      return {
        kind: "failed",
        cause: "parse",
        message: "unexpected response shape (jobs[] missing)",
        retryable: false,
      };
    const now = new Date().toISOString();
    const parsed: HiringSignal[] = [];
    for (const item of jobs) {
      if (item === null || typeof item !== "object") continue;
      const signal = parseJobPayload(item as Record<string, unknown>, board);
      if (signal) parsed.push(signal);
    }
    if (parsed.length === 0) return { kind: "empty", page: { nextPageToken: null } };

    // Local paging: the endpoint returns every posting at once, so the adapter
    // slices to the caller's limit and exposes an OFFSET continuation token.
    // The offset comes from the caller's pageToken, so page 2+ re-fetches the
    // same board response and slices onward — the documented cost of reusing
    // the existing pagination contract instead of changing the run harness.
    const size = Math.min(Math.max(limit, 1), this.manifest().maxPageSize);
    const parsedOffset = pageToken ? Number.parseInt(pageToken, 10) : 0;
    const offset = Number.isInteger(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
    if (offset >= parsed.length) return { kind: "empty", page: { nextPageToken: null } };
    const slice = parsed.slice(offset, offset + size);
    const records: RawRecord[] = slice.map((s) => ({
      sourceRecordId: jobRecordId(board, s.jobId),
      url: s.canonicalUrl,
      retrievedAt: now,
      // Emitted in the SOURCE's own field shape so that normalize(raw) is a
      // true round-trip of what discover produced (a flattened invention here
      // would silently break the contract's normalize step).
      payload: {
        id: s.jobId,
        title: s.title,
        location: s.location === null ? {} : { name: s.location },
        requisition_id: s.requisitionId,
        first_published: s.publishedAt,
        updated_at: s.updatedAt,
        absolute_url: s.canonicalUrl,
        board_token: board,
      },
    }));
    const nextOffset = offset + slice.length;
    const next =
      nextOffset < parsed.length ? String(nextOffset) : null;
    return { kind: "ok", records, page: { nextPageToken: next }, partial: next !== null };
  }

  /** Typed normalizer for the signal workflow (the real use of this source). */
  normalizeJob(raw: RawRecord): HiringSignal | null {
    const board = str((raw.payload ?? {})["board_token"]) ?? "";
    if (!isBoardToken(board)) return null;
    return parseJobPayload(raw.payload, board);
  }

  /**
   * Contract normalizer. This adapter does NOT discover companies, so the
   * company-facing fields are deliberately empty and the gaps are declared
   * rather than guessed. The signal path uses `normalizeJob` instead.
   */
  normalize(raw: RawRecord, manifest: AdapterManifest): NormalizedDiscovery {
    const s = this.normalizeJob(raw);
    const missingFields = ["domain", "website_url", "registry_id", "country_code", "agency_type", "company_identity"];
    if (!s) missingFields.push("job_payload");
    return {
      modelVersion: 1,
      adapterId: manifest.id,
      adapterVersion: manifest.version,
      sourceCategory: manifest.category,
      sourceRecordId: raw.sourceRecordId || "unknown",
      sourceUrl: raw.url || "",
      retrievedAt: raw.retrievedAt || new Date(0).toISOString(),
      // A job title is NOT a company name. Labelled so no downstream consumer
      // can mistake this observation for a company discovery record.
      name: s ? `job posting: ${s.title}` : "(unparseable job posting)",
      agencyType: "other_digital",
      country: "(unknown)",
      missingFields,
      warnings: [
        "this record is a job posting, not a company — it must not create or merge a company",
        ...(s?.warnings ?? ["job payload could not be parsed"]),
        ...(s?.missingFields ?? []).map((f) => `source field missing: ${f}`),
      ],
    };
  }

  provenance(raw: RawRecord, manifest: AdapterManifest): Provenance {
    return {
      adapterId: manifest.id,
      adapterVersion: manifest.version,
      sourceCategory: manifest.category,
      sourceRecordId: raw.sourceRecordId,
      sourceUrl: raw.url,
      retrievedAt: raw.retrievedAt,
    };
  }

  async health(_config: AdapterConfig): Promise<HealthReport> {
    // Keyless public endpoint: readiness cannot be probed without fetching,
    // and health() must not fetch. Per-call failures are reported truthfully.
    return { ready: true, detail: "stateless keyless public API; per-call failures reported" };
  }
}