// Deterministic adapter registry (T-005). Registration and invocation are
// separately controlled: registering NEVER executes an adapter, and listing
// NEVER touches the network. No dynamic loading, no remote plugins.

import {
  ADAPTER_CONTRACT_VERSION,
  type AdapterCapability,
  type AdapterConfig,
  type AdapterFailure,
  type AdapterManifest,
  type DiscoveryOutcome,
  type DiscoveryQuery,
  type SourceAdapter,
} from "./types";

export interface RegistryError {
  code:
    | "duplicate_id"
    | "invalid_manifest"
    | "unknown_adapter"
    | "invalid_config"
    | "capability_missing";
  message: string;
}

export interface SanitizedAdapter {
  id: string;
  name: string;
  version: string;
  category: string;
  capabilities: AdapterCapability[];
  limitations: string[];
  accessRequirements: string;
  maxPageSize: number;
  contractVersion: typeof ADAPTER_CONTRACT_VERSION;
  ready: boolean | null;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/;

function checkManifest(m: AdapterManifest): string | null {
  if (!ID_PATTERN.test(m.id ?? ""))
    return "id must be 3-120 chars of lowercase letters, digits, hyphens";
  if (!m.name || m.name.length > 200) return "name is required (<= 200 chars)";
  if (!m.version || m.version.length > 60) return "version is required (<= 60 chars)";
  if (!/^S-(0[1-9]|1[0-2])$/.test(m.category ?? ""))
    return "category must be one of S-01..S-12";
  if (!Array.isArray(m.capabilities) || m.capabilities.length === 0)
    return "at least one capability is required";
  const known = new Set(["discover", "lookup", "health"]);
  for (const c of m.capabilities) {
    if (!known.has(c)) return `unknown capability: ${c}`;
  }
  if (!Number.isInteger(m.maxPageSize) || m.maxPageSize < 1 || m.maxPageSize > 5000)
    return "maxPageSize must be an integer 1..5000";
  if (!m.accessRequirements) return "accessRequirements must be declared";
  if (!Array.isArray(m.limitations)) return "limitations must be an array";
  return null;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();
  private readonly readyCache = new Map<string, boolean | null>();

  /** Register without executing. Throws RegistryError on duplicates/invalid. */
  register(adapter: SourceAdapter): void {
    const m = adapter.manifest();
    const problem = checkManifest(m);
    if (problem) {
      const e = new Error(problem) as Error & { registryError: RegistryError };
      e.registryError = { code: "invalid_manifest", message: problem };
      throw e;
    }
    if (this.adapters.has(m.id)) {
      const e = new Error(`duplicate adapter id: ${m.id}`) as Error & {
        registryError: RegistryError;
      };
      e.registryError = { code: "duplicate_id", message: `duplicate adapter id: ${m.id}` };
      throw e;
    }
    this.adapters.set(m.id, adapter);
    this.readyCache.set(m.id, null);
  }

  get(id: string): SourceAdapter {
    const a = this.adapters.get(id);
    if (!a) {
      const e = new Error(`unknown adapter: ${id}`) as Error & {
        registryError: RegistryError;
      };
      e.registryError = { code: "unknown_adapter", message: `unknown adapter: ${id}` };
      throw e;
    }
    return a;
  }

  ids(): string[] {
    return [...this.adapters.keys()].sort();
  }

  /** Sanitized listing: metadata only, never config, never secrets. */
  list(): SanitizedAdapter[] {
    return this.ids().map((id) => {
      const m = this.adapters.get(id)!.manifest();
      return {
        id: m.id,
        name: m.name,
        version: m.version,
        category: m.category,
        capabilities: [...m.capabilities],
        limitations: [...m.limitations],
        accessRequirements: m.accessRequirements,
        maxPageSize: m.maxPageSize,
        contractVersion: ADAPTER_CONTRACT_VERSION,
        ready: this.readyCache.get(id) ?? null,
      };
    });
  }

  private checkConfig(adapter: SourceAdapter, config: AdapterConfig): void {
    const v = adapter.validateConfig(config ?? {});
    if (!v.ok) {
      const e = new Error(
        `invalid config: ${v.problems.map((p) => `${p.field}: ${p.message}`).join("; ")}`,
      ) as Error & { registryError: RegistryError };
      e.registryError = {
        code: "invalid_config",
        message: `invalid config: ${v.problems.map((p) => `${p.field}: ${p.message}`).join("; ")}`,
      };
      throw e;
    }
  }

  private requireCapability(
    adapter: SourceAdapter,
    cap: AdapterCapability,
  ): void {
    if (!adapter.manifest().capabilities.includes(cap)) {
      const e = new Error(
        `adapter ${adapter.manifest().id} lacks capability: ${cap}`,
      ) as Error & { registryError: RegistryError };
      e.registryError = {
        code: "capability_missing",
        message: `adapter ${adapter.manifest().id} lacks capability: ${cap}`,
      };
      throw e;
    }
  }

  /**
   * Invoke discovery: validates config + capability first, clamps limit,
   * then delegates. Failures are typed outcomes, never throws for
   * adapter-level problems (registry misuse still throws RegistryError).
   */
  async discover(
    id: string,
    query: DiscoveryQuery,
    config: AdapterConfig,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<DiscoveryOutcome> {
    const adapter = this.get(id);
    this.requireCapability(adapter, "discover");
    this.checkConfig(adapter, config);
    const max = adapter.manifest().maxPageSize;
    const q: DiscoveryQuery = {
      ...query,
      text: (query.text ?? "").slice(0, 500),
      limit: Math.min(Math.max(query.limit ?? max, 1), max),
    };
    if (opts.signal?.aborted) {
      return { kind: "failed", cause: "cancelled", message: "cancelled before start", retryable: false };
    }
    const run = adapter.discover(q, { config, signal: opts.signal });
    if (opts.timeoutMs === undefined) return run;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run,
        new Promise<AdapterFailure>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                kind: "failed",
                cause: "timeout",
                message: `adapter exceeded ${opts.timeoutMs}ms`,
                retryable: true,
              }),
            opts.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Readiness probe: delegates to adapter health(), caches the boolean. */
  async checkHealth(id: string, config: AdapterConfig): Promise<boolean> {
    const adapter = this.get(id);
    this.requireCapability(adapter, "health");
    this.checkConfig(adapter, config);
    try {
      const r = await adapter.health(config);
      this.readyCache.set(id, r.ready);
      return r.ready;
    } catch {
      this.readyCache.set(id, false);
      return false;
    }
  }
}

/** Production registry factory. Test adapters are injected by callers. */
export function createRegistry(extra: SourceAdapter[] = []): AdapterRegistry {
  const r = new AdapterRegistry();
  for (const a of extra) r.register(a);
  return r;
}
