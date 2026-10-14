// GLEIF LEI Index adapter (T-006). First real discovery source.
//
// ACCESS (verified 2026-10-13, see docs/T006_SOURCE_SELECTION.md): public
// open-data JSON:API at https://api.gleif.org, NO key, NO registration.
// Verified live: collection fetch (3.4M records) and filter[fulltext]
// search both return HTTP 200 keyless. Rate limits: none published —
// mitigated with small pages, bounded runs, and backoff on 429.
// FIT CAVEAT: LEI holders skew to larger/regulated entities; small agencies
// rarely hold LEIs, so agency yield is expected to be low. This adapter
// proves one reliable end-to-end path with authoritative records.

import {
  fetchJson,
  sleepAbortable,
  type FetchImpl,
} from "../http";
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

export const GLEIF_ADAPTER_ID = "gleif-lei";
const GLEIF_ADAPTER_VERSION = "0.1.0";
const GLEIF_BASE = "https://api.gleif.org";
const MAX_RETRIES = 2;

interface Deps {
  fetchImpl?: FetchImpl;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export class GleifAdapter implements SourceAdapter {
  private readonly fetchImpl?: FetchImpl;

  constructor(deps: Deps = {}) {
    this.fetchImpl = deps.fetchImpl;
  }

  manifest(): AdapterManifest {
    return {
      id: GLEIF_ADAPTER_ID,
      name: "GLEIF LEI Index",
      version: GLEIF_ADAPTER_VERSION,
      category: "S-02",
      capabilities: ["discover", "health"],
      limitations: [
        "LEI records carry no sector data — agency fit is always unverified",
        "no domains or websites in records (missingFields, never invented)",
        "small agencies rarely hold LEIs; agency yield expected to be low",
        "single query per run; no bulk export in this adapter",
      ],
      accessRequirements: "none — public open-data API, no key (verified 2026-10-13)",
      maxPageSize: 25,
    };
  }

  validateConfig(config: AdapterConfig): ConfigValidation {
    const c = (config ?? {}) as Record<string, unknown>;
    const problems: { field: string; message: string }[] = [];
    for (const k of Object.keys(c))
      problems.push({ field: k, message: "unknown option (this adapter takes no configuration)" });
    return problems.length > 0 ? { ok: false, problems } : { ok: true };
  }

  private buildUrl(query: DiscoveryQuery): string {
    const limit = Math.min(Math.max(query.limit ?? 10, 1), this.manifest().maxPageSize);
    const page = query.pageToken ? Number.parseInt(query.pageToken, 10) : 1;
    const params = new URLSearchParams({
      "filter[fulltext]": query.text,
      "page[size]": String(limit),
      "page[number]": String(Number.isInteger(page) && page >= 1 ? page : 1),
    });
    return `${GLEIF_BASE}/api/v1/lei-records?${params.toString()}`;
  }

  private async get(
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<
    | { ok: true; json: unknown }
    | { ok: false; retry: boolean; cause: "rate_limited" | "network" | "auth" | "terms_block" | "misconfigured" | "parse"; message: string }
    | { ok: false; cancelled: true }
  > {
    const r = await fetchJson(url, { signal, fetchImpl: this.fetchImpl });
    if (r.ok) return { ok: true, json: r.json };
    switch (r.kind) {
      case "cancelled":
        return { ok: false, cancelled: true as const };
      case "network":
        return { ok: false, retry: true, cause: "network", message: r.message };
      case "redirect_blocked":
        return { ok: false, retry: false, cause: "terms_block", message: r.message };
      case "http": {
        const s = r.status ?? 0;
        if (s === 429) return { ok: false, retry: true, cause: "rate_limited", message: "source rate limit (429)" };
        if (s === 401) return { ok: false, retry: false, cause: "auth", message: "source auth failure (401)" };
        if (s === 403) return { ok: false, retry: false, cause: "terms_block", message: "source forbids this access (403)" };
        if (s >= 500) return { ok: false, retry: true, cause: "network", message: r.message };
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
    const text = (query.text ?? "").trim();
    if (text.length < 1)
      return {
        kind: "failed",
        cause: "misconfigured",
        message: "query text is required (bare index scans forbidden)",
        retryable: false,
      };

    const url = this.buildUrl({ ...query, text });
    let attempt = 0;
    for (;;) {
      const r = await this.get(url, ctx.signal);
      if (r.ok) return this.toOutcome(r.json);
      if ("cancelled" in r)
        return { kind: "failed", cause: "cancelled", message: "cancelled during run", retryable: false };
      if (!r.retry || attempt >= MAX_RETRIES)
        return { kind: "failed", cause: r.cause, message: r.message, retryable: r.retry };
      attempt += 1;
      const backoff = attempt === 1 ? 500 : 1500;
      if (await sleepAbortable(backoff, ctx.signal))
        return { kind: "failed", cause: "cancelled", message: "cancelled during backoff", retryable: false };
    }
  }

  private toOutcome(json: unknown): DiscoveryOutcome {
    const doc = (json ?? {}) as Record<string, unknown>;
    const data = (doc as { data?: unknown }).data;
    if (!Array.isArray(data))
      return { kind: "failed", cause: "parse", message: "unexpected response shape (data[] missing)", retryable: false };
    const now = new Date().toISOString();
    const records: RawRecord[] = [];
    for (const item of data) {
      const rec = (item ?? {}) as Record<string, unknown>;
      const id = str(rec["id"]);
      const attrs = rec["attributes"];
      const links = (rec["links"] ?? {}) as Record<string, unknown>;
      records.push({
        sourceRecordId: id ?? "unknown",
        url: str(links["self"]) ?? "",
        retrievedAt: now,
        payload: (attrs ?? {}) as Record<string, unknown>,
      });
    }
    if (records.length === 0) return { kind: "empty", page: { nextPageToken: null } };
    const links = (doc["links"] ?? {}) as Record<string, unknown>;
    // Pagination: derive next page from links.next when present.
    let next: string | null = null;
    const nextUrl = str(links["next"]);
    if (nextUrl) {
      try {
        const page = new URL(nextUrl).searchParams.get("page[number]");
        if (page && /^\d+$/.test(page)) next = page;
      } catch {
        next = null;
      }
    }
    return { kind: "ok", records, page: { nextPageToken: next }, partial: next !== null };
  }

  normalize(raw: RawRecord, manifest: AdapterManifest): NormalizedDiscovery {
    const p = (raw.payload ?? {}) as Record<string, unknown>;
    const entity = (p["entity"] ?? {}) as Record<string, unknown>;
    const legalName = (entity["legalName"] ?? {}) as Record<string, unknown>;
    const legalAddr = (entity["legalAddress"] ?? {}) as Record<string, unknown>;
    const hqAddr = (entity["headquartersAddress"] ?? {}) as Record<string, unknown>;
    const missingFields: string[] = [];
    const warnings: string[] = ["no sector data in LEI records; agency fit unverified"];

    const name = str(legalName["name"]) ?? str(p["name"]);
    if (!name) missingFields.push("name");
    const country =
      str(legalAddr["country"]) ?? str(hqAddr["country"]) ?? str(entity["jurisdiction"]);
    if (!country) missingFields.push("country");
    const countryCode =
      country && /^[A-Z]{2}$/.test(country) ? country : undefined;
    if (country && !countryCode)
      warnings.push(`country value '${country}' is not ISO alpha-2; left unset`);
    const status = str(entity["status"]);
    if (status && status !== "ACTIVE") warnings.push(`entity status ${status} (not ACTIVE)`);
    if (!str(raw.url)) warnings.push("source URL missing; recorded as-is, do not fetch blindly");
    const lei = str(p["lei"]);

    return {
      modelVersion: 1,
      adapterId: manifest.id,
      adapterVersion: manifest.version,
      sourceCategory: manifest.category,
      sourceRecordId: raw.sourceRecordId || "unknown",
      sourceUrl: raw.url || "",
      retrievedAt: raw.retrievedAt || new Date(0).toISOString(),
      name: name ?? "(unnamed record)",
      domain: undefined,
      registryId: lei,
      registryType: lei ? "lei" : undefined,
      agencyType: "other_digital",
      country: country ?? "(unknown)",
      countryCode,
      region: str(legalAddr["region"]) ?? str(hqAddr["region"]),
      websiteUrl: undefined,
      missingFields: [...missingFields, "domain", "website_url"],
      warnings,
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
    // Stateless keyless public API: nothing to validate without fetching.
    // Readiness is assumed; every discover() call reports real failures.
    return { ready: true, detail: "stateless public API; per-call failures reported" };
  }
}
