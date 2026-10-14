/**
 * T-005 adapter contract + registry + fixture tests. No network: any fetch
 * attempt fails the suite (global fetch is stubbed to throw in one test and
 * the fixture takes no HTTP client at all).
 */
import { Pool } from "pg";
import { readFileSync } from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateCompanyInput } from "../lib/intake/validate";
import { createCompany } from "../lib/intake/import";
import { findCandidates } from "../lib/resolve/engine";
import { validateFetchUrl } from "../lib/discovery/fetch-guard";
import { AdapterRegistry, createRegistry } from "../lib/discovery/registry";
import {
  AgencyDirectoryFixture,
  FIXTURE_ID,
} from "../lib/discovery/fixtures/agency-directory";
import type {
  AdapterManifest,
  DiscoveryQuery,
  SourceAdapter,
} from "../lib/discovery/types";

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.T003_TEST_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 3 });

function stubAdapter(overrides: { id: string } & Record<string, unknown>): SourceAdapter {
  const fx = new AgencyDirectoryFixture();
  const manifest = { ...fx.manifest(), ...overrides } as AdapterManifest;
  const stub: SourceAdapter = {
    manifest: () => manifest,
    validateConfig: () => ({ ok: true }),
    discover: () => Promise.resolve({ kind: "empty", page: { nextPageToken: null } }),
    normalize: (raw, m) => fx.normalize(raw, m),
    provenance: (raw, m) => fx.provenance(raw, m),
    health: () => Promise.resolve({ ready: true, detail: "stub" }),
  };
  return stub;
}

describe("registry", () => {
  it("registers, looks up, and lists valid adapters", () => {
    const r = createRegistry([new AgencyDirectoryFixture()]);
    expect(r.ids()).toEqual([FIXTURE_ID]);
    expect(r.get(FIXTURE_ID).manifest().id).toBe(FIXTURE_ID);
    const [listed] = r.list();
    expect(listed).toMatchObject({
      id: FIXTURE_ID,
      category: "S-05",
      contractVersion: 1,
    });
    expect(JSON.stringify(listed)).not.toMatch(/apiKey|secret|token/i);
  });

  it("rejects duplicate ids", () => {
    const r = createRegistry([new AgencyDirectoryFixture()]);
    expect(() => r.register(new AgencyDirectoryFixture())).toThrow(/duplicate adapter id/);
  });

  it("rejects invalid manifests", () => {
    const bad = [
      { id: "BAD ID!" },
      { id: "x-ok", category: "S-13" },
      { id: "x-ok", category: "S-01", capabilities: [] },
      { id: "x-ok", category: "S-01", capabilities: ["nope"] },
      { id: "x-ok", category: "S-01", capabilities: ["discover"], maxPageSize: 0 },
    ];
    for (const patch of bad) {
      const r = new AdapterRegistry();
      expect(() => r.register(stubAdapter(patch as { id: string }))).toThrow();
    }
  });

  it("throws unknown_adapter on missing lookup", () => {
    expect(() => createRegistry().get("nope")).toThrow(/unknown adapter/);
  });

  it("rejects invalid config and capability mismatch before invocation", async () => {
    const r = createRegistry([new AgencyDirectoryFixture()]);
    await expect(
      r.discover(FIXTURE_ID, { text: "x" }, { scenario: "bogus" }),
    ).rejects.toMatchObject({ registryError: { code: "invalid_config" } });
    const healthOnly = new AdapterRegistry();
    healthOnly.register(
      stubAdapter({ id: "health-only", category: "S-08", capabilities: ["health"] }),
    );
    await expect(
      healthOnly.discover("health-only", { text: "x" }, {}),
    ).rejects.toMatchObject({ registryError: { code: "capability_missing" } });
  });

  it("never executes adapters on register or list", async () => {
    let calls = 0;
    const fx = new AgencyDirectoryFixture();
    const counting: SourceAdapter = {
      manifest: () => fx.manifest(),
      validateConfig: (c) => fx.validateConfig(c),
      discover: (...a) => {
        calls += 1;
        return fx.discover(...a);
      },
      normalize: (r, m) => fx.normalize(r, m),
      provenance: (r, m) => fx.provenance(r, m),
      health: (c) => fx.health(c),
    };
    const r = createRegistry([counting]);
    r.list();
    r.get(FIXTURE_ID);
    expect(calls).toBe(0);
  });
});

describe("fixture outcomes", () => {
  const reg = () => createRegistry([new AgencyDirectoryFixture()]);
  const q = (over: Partial<DiscoveryQuery> = {}): DiscoveryQuery => ({ text: "web agencies", ...over });

  it("returns deterministic repeatable records", async () => {
    const a = await reg().discover(FIXTURE_ID, q({ limit: 3 }), { seed: 11 });
    const b = await reg().discover(FIXTURE_ID, q({ limit: 3 }), { seed: 11 });
    expect(a.kind).toBe("ok");
    expect(b.kind).toBe("ok");
    if (a.kind === "ok" && b.kind === "ok") {
      expect(a.records.map((r) => r.payload)).toEqual(b.records.map((r) => r.payload));
      expect(a.records[0].payload).toMatchObject({ name: expect.stringContaining("(SYNTHETIC)") });
      for (const rec of a.records) {
        expect(rec.url).toMatch(/^https:\/\//);
        expect(Date.parse(rec.retrievedAt)).not.toBeNaN();
      }
    }
  });

  it("supports empty results", async () => {
    const r = await reg().discover(FIXTURE_ID, q(), { scenario: "empty" });
    expect(r).toEqual({ kind: "empty", page: { nextPageToken: null } });
  });

  it("walks partial pages explicitly to completion", async () => {
    const r = createRegistry([new AgencyDirectoryFixture()]);
    const p1 = await r.discover(FIXTURE_ID, q({ limit: 3 }), { scenario: "partial", seed: 5 });
    expect(p1.kind).toBe("ok");
    if (p1.kind !== "ok") return;
    expect(p1.partial).toBe(true);
    expect(p1.records).toHaveLength(3);
    expect(p1.page.nextPageToken).toBe("3");
    const p2 = await r.discover(FIXTURE_ID, q({ limit: 3, pageToken: p1.page.nextPageToken! }), {
      scenario: "partial",
      seed: 5,
    });
    expect(p2.kind).toBe("ok");
    if (p2.kind !== "ok") return;
    expect(p2.partial).toBe(false);
    expect(p2.page.nextPageToken).toBeNull();
    expect(p2.records).toHaveLength(2);
    const ids = [...p1.records, ...p2.records].map((x) => x.sourceRecordId);
    expect(new Set(ids).size).toBe(5);
  });

  it("returns typed failures with retry guidance", async () => {
    const r = createRegistry([new AgencyDirectoryFixture()]);
    const net = await r.discover(FIXTURE_ID, q(), { scenario: "error", cause: "network" });
    expect(net).toMatchObject({ kind: "failed", cause: "network", retryable: true });
    const auth = await r.discover(FIXTURE_ID, q(), { scenario: "error", cause: "auth" });
    expect(auth).toMatchObject({ kind: "failed", cause: "auth", retryable: false });
    expect(JSON.stringify(auth)).not.toMatch(/SECRET/);
  });

  it("honors cancellation and registry timeouts", async () => {
    const r = createRegistry([new AgencyDirectoryFixture()]);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      r.discover(FIXTURE_ID, q(), { latencyMs: 50 }, { signal: ctrl.signal }),
    ).resolves.toMatchObject({ kind: "failed", cause: "cancelled" });
    await expect(
      r.discover(FIXTURE_ID, q(), { latencyMs: 300 }, { timeoutMs: 20 }),
    ).resolves.toMatchObject({ kind: "failed", cause: "timeout", retryable: true });
  });

  it("performs zero network access", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network attempted");
    });
    try {
      const r = createRegistry([new AgencyDirectoryFixture()]);
      const out = await r.discover(FIXTURE_ID, q({ limit: 2 }), { seed: 1 });
      expect(out.kind).toBe("ok");
      expect(spy).not.toHaveBeenCalled();
      expect(await r.checkHealth(FIXTURE_ID, {})).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("normalization", () => {
  const fx = new AgencyDirectoryFixture();
  const m = fx.manifest();

  it("maps fixture records with provenance, flags gaps explicitly", () => {
    const n = fx.normalize(
      {
        sourceRecordId: "r1",
        url: "https://directory.example/listings/r1",
        retrievedAt: new Date().toISOString(),
        payload: { name: "A (SYNTHETIC)", domain: "a.example", country: "United States" },
      },
      m,
    );
    expect(n).toMatchObject({
      modelVersion: 1,
      adapterId: FIXTURE_ID,
      sourceCategory: "S-05",
      agencyType: "other_digital",
    });
    expect(n.missingFields).toContain("agency_type");
    const p = fx.provenance(
      { sourceRecordId: "r1", url: "u", retrievedAt: "t", payload: {} },
      m,
    );
    expect(p).toMatchObject({ adapterId: FIXTURE_ID, sourceRecordId: "r1" });
  });

  it("tolerates malformed payloads without throwing", () => {
    for (const payload of [{}, { name: 42 }, null, "text"]) {
      const n = fx.normalize(
        { sourceRecordId: "bad", url: "not a url", retrievedAt: "x", payload: payload as never },
        m,
      );
      expect(n.name).toBeDefined();
      expect(n.warnings.length + n.missingFields.length).toBeGreaterThan(0);
    }
  });
});

describe("fetch guard (preventive, no networking in T-005)", () => {
  it("allows public http(s) names", () => {
    expect(validateFetchUrl("https://example.com/listings").ok).toBe(true);
    expect(validateFetchUrl("http://example.com/").ok).toBe(true);
  });
  it("blocks loopback, private, metadata, and disguised literals", () => {
    const bad = [
      "http://127.0.0.1/",
      "http://10.0.0.5/x",
      "http://192.168.1.1/",
      "http://172.16.4.4/",
      "http://169.254.169.254/latest",
      "http://localhost:3000/",
      "http://x.localhost/",
      "http://[::1]/",
      "http://0x7f.0.0.1/",
      "http://2130706433/",
      "http://metadata.google.internal/",
      "ftp://example.com/",
      "https://user:pass@example.com/",
      "not a url",
    ];
    for (const u of bad) {
      expect(validateFetchUrl(u).ok, u).toBe(false);
    }
  });
});

describe("intake + identity compatibility", () => {
  afterEach(async () => {
    const c = await pool.connect();
    try {
      await c.query("delete from public.company where domain_norm like 'fixture-%'");
    } finally {
      c.release();
    }
  });

  it("normalized fixture records validate for intake; malformed ones do not", () => {
    const fx = new AgencyDirectoryFixture();
    const good = fx.normalize(
      {
        sourceRecordId: "r1",
        url: "https://directory.example/listings/r1",
        retrievedAt: new Date().toISOString(),
        payload: { name: "Good (SYNTHETIC)", domain: "good-one.example", country: "United States" },
      },
      fx.manifest(),
    );
    expect(
      validateCompanyInput({
        name: good.name,
        domain: good.domain ?? "",
        agencyType: good.agencyType,
        country: good.country,
      }).ok,
    ).toBe(true);
    const bad = fx.normalize(
      {
        sourceRecordId: "bad",
        url: "not a url",
        retrievedAt: new Date().toISOString(),
        payload: { domain: "x.example" },
      },
      fx.manifest(),
    );
    expect(bad.missingFields).toContain("name");
    expect(
      validateCompanyInput({
        name: "",
        domain: "x.example",
        agencyType: "web_development",
        country: "United States",
      }).ok,
    ).toBe(false);
  });

  it("fixture-created companies resolve through T-004 without network", async () => {
    const { companyId } = await createCompany(
      pool,
      { name: "Fixture Probe (SYNTHETIC)", domain: "fixture-probe-99.example", agencyType: "web_development", country: "United States" },
      "t5test",
    );
    const r = await findCandidates(pool, companyId, { actor: "t5test" });
    expect(r.skipped).toBeNull();
    expect(Array.isArray(r.candidates)).toBe(true);
    const c = await pool.connect();
    try {
      // Audit rows are append-only by design; the t5test-labeled rows persist
      // as evidence (same convention as t3test/rxtest suites).
      await c.query("delete from public.company where id = $1", [companyId]);
    } finally {
      c.release();
    }
  });
});

describe("adapter API surface", () => {
  it("GET /api/adapters is read-only, open, and secret-free (static contract)", () => {
    // Read-only listing intentionally requires no token (matches GET
    // /api/companies convention); mutating routes stay gated. The handler
    // must not reference tokens, secrets, or execution triggers.
    const src = readFileSync("app/api/adapters/route.ts", "utf8");
    expect(src).not.toMatch(/checkOperatorToken|SECRET|apiKey|password/i);
    expect(src).toMatch(/AgencyDirectoryFixture/);
  });
});
