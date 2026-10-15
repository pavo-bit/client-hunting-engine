// Source adapter contract (T-005). Framework only — no live acquisition.
// Compatible with the documented shape in SOURCE_INTEGRATION_PLAN.md
// §adapter-interface: key/category/isEnabled/discover/normalize/provenance,
// typed failures, contract tests on recorded fixtures, no live calls.
//
// SEPARATION (enforced by types):
//   acquisition (Adapter.discover, source-specific) ->
//   normalization (Adapter.normalize, pure) ->
//   intake/identity (existing lib/intake + lib/resolve; adapters never write).
// Discovery output is an OBSERVATION, never proof of identity or ownership.

/** The 12 approved source categories. No other value is representable. */
export type SourceCategory =
  | "S-01" | "S-02" | "S-03" | "S-04" | "S-05" | "S-06"
  | "S-07" | "S-08" | "S-09" | "S-10" | "S-11" | "S-12";

/** Capabilities an adapter may declare. Registry checks these before use. */
export type AdapterCapability =
  | "discover" // paged discovery by query
  | "lookup" // direct record fetch by source-specific id
  | "health"; // readiness self-report without invasive probing

/** Typed failure causes. Matches the platform vocabulary. */
export type AdapterFailureCause =
  | "rate_limited"
  | "auth"
  | "terms_block"
  | "parse"
  | "network"
  | "injection_suspect"
  | "cancelled"
  | "timeout"
  | "misconfigured";

export interface AdapterFailure {
  kind: "failed";
  cause: AdapterFailureCause;
  /** Safe diagnostic text. MUST NOT contain secrets (tested). */
  message: string;
  /** Machine hint: caller may retry with backoff. */
  retryable: boolean;
}

/** Validated discovery request. Adapters validate before any work. */
export interface DiscoveryQuery {
  /** Free-text query (provider syntax is adapter-specific, documented). */
  text: string;
  countryCode?: string;
  agencyType?: string;
  /** Opaque continuation token from a previous partial result. */
  pageToken?: string;
  /** Upper bound for records in one response (adapter clamps to its max). */
  limit?: number;
}

/** Pagination / continuation semantics. Absent nextPageToken = complete. */
export interface PageInfo {
  nextPageToken: string | null;
}

/** Raw record as returned by acquisition, before normalization. */
export interface RawRecord {
  /** Source-specific stable id for this record. */
  sourceRecordId: string;
  /** Original source URL (validated before downstream use). */
  url: string;
  /** ISO retrieval timestamp set by acquisition. */
  retrievedAt: string;
  /** Untrusted source payload. NEVER interpreted as instructions. */
  payload: Record<string, unknown>;
}

/**
 * Normalized discovery result (model version 1). Compatible with intake
 * CompanyInput: adapters produce observations; intake validation +
 * identity resolution decide what becomes canonical.
 */
export interface NormalizedDiscovery {
  modelVersion: 1;
  adapterId: string;
  adapterVersion: string;
  sourceCategory: SourceCategory;
  sourceRecordId: string;
  sourceUrl: string;
  retrievedAt: string;
  name: string;
  domain?: string;
  registryId?: string;
  registryType?: string;
  agencyType: string;
  country: string;
  countryCode?: string;
  region?: string;
  websiteUrl?: string;
  /** Fields the source did not supply (explicit, not silent). */
  missingFields: string[];
  /** Non-fatal validation notes (e.g. unparseable optional field). */
  warnings: string[];
}

export interface Provenance {
  adapterId: string;
  adapterVersion: string;
  sourceCategory: SourceCategory;
  sourceRecordId: string;
  sourceUrl: string;
  retrievedAt: string;
}

/** Successful execution. Partial responses carry pageInfo + incomplete flag. */
export interface DiscoverySuccess {
  kind: "ok";
  records: RawRecord[];
  page: PageInfo;
  /** True when the adapter knows more pages exist but did not fetch them. */
  partial: boolean;
}

export interface EmptyResult {
  kind: "empty";
  page: PageInfo;
}

export type DiscoveryOutcome =
  | DiscoverySuccess
  | EmptyResult
  | AdapterFailure;

export interface AdapterManifest {
  /** Stable identifier, e.g. "agency-directory-fixture". Unique in registry. */
  id: string;
  /** Human-readable name. */
  name: string;
  version: string;
  category: SourceCategory;
  capabilities: AdapterCapability[];
  /** Declared limits: what the adapter will NOT do. */
  limitations: string[];
  /** Permission/access requirements (e.g. "official API key", "manual only"). */
  accessRequirements: string;
  /** Maximum records per discover() call (adapter clamps higher limits). */
  maxPageSize: number;
  /**
   * Source-registry key this adapter collects from. Gated by
   * `public.source.enabled` before every run (amendment §4F / B-D5): present +
   * enabled = may run; absent or disabled = refused, fail closed. Omitted
   * means "use the run module's default source key" (legacy adapters).
   */
  sourceKey?: string;
}

/** Opaque, adapter-defined configuration. Secrets stay server-side. */
export type AdapterConfig = Record<string, unknown>;

/** Result of validateConfig: ok or a list of field problems. */
export type ConfigValidation =
  | { ok: true }
  | { ok: false; problems: { field: string; message: string }[] };

/** Readiness self-report. Must not probe invasively or fetch data. */
export interface HealthReport {
  ready: boolean;
  detail: string;
}

/**
 * The adapter contract. Small and cohesive on purpose; every method is
 * exercised by the contract test-suite shape in tests/adapters.test.ts.
 */
export interface SourceAdapter {
  manifest(): AdapterManifest;
  /** Pure validation of config. Must not touch the network or secrets store. */
  validateConfig(config: AdapterConfig): ConfigValidation;
  /**
   * Acquire one page. Honors AbortSignal (→ cancelled failure) and never
   * runs on register()/list(). Partial results are explicit, never silent.
   */
  discover(
    query: DiscoveryQuery,
    ctx: { config: AdapterConfig; signal?: AbortSignal },
  ): Promise<DiscoveryOutcome>;
  /** Pure: raw record → normalized observation (untrusted input tolerated). */
  normalize(raw: RawRecord, manifest: AdapterManifest): NormalizedDiscovery;
  /** Pure: provenance snapshot for a raw record. */
  provenance(raw: RawRecord, manifest: AdapterManifest): Provenance;
  /** Readiness without data fetching. */
  health(config: AdapterConfig): Promise<HealthReport>;
}

/** Contract version marker for forward-compatible evolution. */
export const ADAPTER_CONTRACT_VERSION = 1 as const;
