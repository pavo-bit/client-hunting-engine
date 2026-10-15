// Deterministic fixture adapter (T-005). Synthetic, clearly labeled,
// repeatable records for development and contract tests.
//
// HARD LIMITS: no network access (pure functions + timers only), never
// seeded into production by default (not registered in production code),
// scenarios cover ok / empty / partial / malformed / error.

import type {
  AdapterConfig,
  AdapterFailureCause,
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

export const FIXTURE_ID = "agency-directory-fixture";
const FIXTURE_VERSION = "0.1.0";

const SCENARIOS = ["ok", "empty", "partial", "malformed", "error"] as const;
type Scenario = (typeof SCENARIOS)[number];

const CAUSES = ["network", "rate_limited", "auth", "terms_block", "parse"] as const;

const COUNTRIES: Array<[string, string]> = [
  ["United States", "US"],
  ["Germany", "DE"],
  ["Singapore", "SG"],
];

/** Deterministic PRNG (mulberry32) over a string hash. */
export function seededRandom(seedText: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) {
    h ^= seedText.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FixtureConfig {
  scenario?: Scenario;
  cause?: (typeof CAUSES)[number];
  seed?: number;
  latencyMs?: number;
}

function readConfig(config: AdapterConfig): FixtureConfig {
  const c = (config ?? {}) as Record<string, unknown>;
  const out: FixtureConfig = {};
  if (typeof c["scenario"] === "string") out.scenario = c["scenario"] as Scenario;
  if (typeof c["cause"] === "string") out.cause = c["cause"] as FixtureConfig["cause"];
  if (typeof c["seed"] === "number") out.seed = c["seed"];
  if (typeof c["latencyMs"] === "number") out.latencyMs = c["latencyMs"];
  return out;
}

const RETRYABLE: Record<string, boolean> = {
  network: true,
  rate_limited: true,
  auth: false,
  terms_block: false,
  parse: false,
};

function recordId(seed: number, n: number): string {
  return `fixture-${seed}-${n}`;
}

function makeRecord(seed: number, n: number, retrievedAt: string): RawRecord {
  const [country, cc] = COUNTRIES[n % COUNTRIES.length];
  return {
    sourceRecordId: recordId(seed, n),
    url: `https://directory.example/listings/${recordId(seed, n)}`,
    retrievedAt,
    payload: {
      name: `Fixture Agency ${n} (SYNTHETIC)`,
      domain: `fixture-${seed}-${n}.example`,
      agency_type: ["web_development", "custom_software", "mobile_app"][n % 3],
      country,
      country_code: cc,
    },
  };
}

function malformedRecord(kind: number, retrievedAt: string): RawRecord {
  if (kind === 0) {
    return {
      sourceRecordId: "fixture-malformed-noname",
      url: "https://directory.example/listings/noname",
      retrievedAt,
      payload: { domain: "noname.example", country: "United States" },
    };
  }
  return {
    sourceRecordId: "fixture-malformed-badurl",
    url: "not a url at all",
    retrievedAt,
    payload: { name: "Bad URL Co (SYNTHETIC)", domain: "badurl.example", country: "Nowhere" },
  };
}

export class AgencyDirectoryFixture implements SourceAdapter {
  manifest(): AdapterManifest {
    return {
      id: FIXTURE_ID,
      name: "Agency Directory (fixture)",
      version: FIXTURE_VERSION,
      category: "S-05",
      capabilities: ["discover", "health"],
      limitations: [
        "synthetic records only — clearly labeled SYNTHETIC",
        "no network access; no live data",
        "not registered in production code",
      ],
      accessRequirements: "none - local fixture, no credentials",
      // Synthetic stand-in for the agency-directory source (S-05). The
      // registry row is what authorizes the run; the fixture adds no
      // permission of its own (amendment §4F).
      sourceKey: "agency-directory",
      maxPageSize: 25,
    };
  }

  validateConfig(config: AdapterConfig): ConfigValidation {
    const c = (config ?? {}) as Record<string, unknown>;
    const problems: { field: string; message: string }[] = [];
    if (c["scenario"] !== undefined && !(SCENARIOS as readonly string[]).includes(c["scenario"] as string))
      problems.push({ field: "scenario", message: `must be one of: ${SCENARIOS.join(", ")}` });
    if (c["cause"] !== undefined && !(CAUSES as readonly string[]).includes(c["cause"] as string))
      problems.push({ field: "cause", message: `must be one of: ${CAUSES.join(", ")}` });
    if (c["seed"] !== undefined && (!Number.isInteger(c["seed"]) || (c["seed"] as number) < 0))
      problems.push({ field: "seed", message: "must be a non-negative integer" });
    if (
      c["latencyMs"] !== undefined &&
      (!Number.isInteger(c["latencyMs"]) || (c["latencyMs"] as number) < 0 || (c["latencyMs"] as number) > 5000)
    )
      problems.push({ field: "latencyMs", message: "must be an integer 0..5000" });
    for (const k of Object.keys(c)) {
      if (!["scenario", "cause", "seed", "latencyMs"].includes(k))
        problems.push({ field: k, message: "unknown fixture option" });
    }
    return problems.length > 0 ? { ok: false, problems } : { ok: true };
  }

  async discover(
    query: DiscoveryQuery,
    ctx: { config: AdapterConfig; signal?: AbortSignal },
  ): Promise<DiscoveryOutcome> {
    const cfg = readConfig(ctx.config);
    const scenario: Scenario = cfg.scenario ?? "ok";
    const seed = cfg.seed ?? 7;
    const latency = cfg.latencyMs ?? 0;
    const limit = Math.min(Math.max(query.limit ?? 5, 1), this.manifest().maxPageSize);
    const now = new Date().toISOString();

    if (ctx.signal?.aborted) {
      return { kind: "failed", cause: "cancelled", message: "cancelled before start", retryable: false };
    }
    if (latency > 0) {
      const cancelled = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), latency);
        const onAbort = () => {
          clearTimeout(t);
          resolve(true);
        };
        if (ctx.signal?.aborted) onAbort();
        else ctx.signal?.addEventListener("abort", onAbort, { once: true });
      });
      if (cancelled) {
        return { kind: "failed", cause: "cancelled", message: "cancelled during wait", retryable: false };
      }
    }
    if (ctx.signal?.aborted) {
      return { kind: "failed", cause: "cancelled", message: "cancelled during run", retryable: false };
    }

    if (scenario === "empty") return { kind: "empty", page: { nextPageToken: null } };
    if (scenario === "error") {
      const cause: AdapterFailureCause = (cfg.cause ?? "network") as AdapterFailureCause;
      return {
        kind: "failed",
        cause,
        message: `fixture ${cause} failure (synthetic)`,
        retryable: RETRYABLE[cause] ?? false,
      };
    }
    if (scenario === "malformed") {
      return {
        kind: "ok",
        records: [malformedRecord(0, now), malformedRecord(1, now)],
        page: { nextPageToken: null },
        partial: false,
      };
    }
    // ok + partial: deterministic total of limit + 2 across two pages.
    const total = limit + 2;
    const offset = query.pageToken ? Number.parseInt(query.pageToken, 10) || 0 : 0;
    const records: RawRecord[] = [];
    for (let n = offset; n < Math.min(offset + limit, total); n++) {
      records.push(makeRecord(seed, n, now));
    }
    const next = offset + limit < total ? String(offset + limit) : null;
    if (scenario === "partial" && next === null) {
      // Partial scenario on the final page still reports completion.
      return { kind: "ok", records, page: { nextPageToken: null }, partial: false };
    }
    return {
      kind: "ok",
      records,
      page: { nextPageToken: scenario === "ok" ? null : next },
      partial: scenario === "partial" && next !== null,
    };
  }

  normalize(raw: RawRecord, manifest: AdapterManifest): NormalizedDiscovery {
    const p = (raw.payload ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
    const missingFields: string[] = [];
    const warnings: string[] = [];
    const name = str(p["name"]);
    if (!name) missingFields.push("name");
    const country = str(p["country"]);
    if (!country) missingFields.push("country");
    const url = str(raw.url);
    let sourceUrl = url ?? "";
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      warnings.push("source URL missing or not http(s); recorded verbatim, do not fetch");
      sourceUrl = url ?? "";
    }
    const agencyType = str(p["agency_type"]);
    const knownTypes = [
      "web_development", "custom_software", "mobile_app",
      "ecommerce", "automation_consultancy", "other_digital",
    ];
    let agency = "other_digital";
    if (agencyType) {
      if (knownTypes.includes(agencyType)) agency = agencyType;
      else warnings.push(`unknown agency_type '${agencyType}', defaulted to other_digital`);
    } else {
      missingFields.push("agency_type");
    }
    return {
      modelVersion: 1,
      adapterId: manifest.id,
      adapterVersion: manifest.version,
      sourceCategory: manifest.category,
      sourceRecordId: str(raw.sourceRecordId) ?? "unknown",
      sourceUrl,
      retrievedAt: str(raw.retrievedAt) ?? new Date(0).toISOString(),
      name: name ?? "(unnamed record)",
      domain: str(p["domain"]),
      registryId: str(p["registry_id"]),
      registryType: str(p["registry_type"]),
      agencyType: agency,
      country: country ?? "(unknown)",
      countryCode: str(p["country_code"]),
      region: str(p["region"]),
      websiteUrl: str(p["website_url"]),
      missingFields,
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
    const cfg = readConfig(_config);
    if ((cfg.scenario ?? "ok") === "error")
      return { ready: false, detail: "fixture error scenario" };
    return { ready: true, detail: "fixture ready (no network)" };
  }
}
