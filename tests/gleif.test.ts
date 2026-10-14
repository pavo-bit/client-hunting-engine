/**
 * T-006 GLEIF adapter + run tests. Offline by default: all source traffic
 * goes through an injected mock fetch serving recorded fixtures
 * (tests/fixtures/gleif/). A live smoke test runs only with
 * GLEIF_LIVE_SMOKE=1 (bounded: 1 query, 2 records, public open-data API).
 */
import { readFileSync } from "fs";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { AdapterRegistry, createRegistry } from "../lib/discovery/registry";
import { GleifAdapter, GLEIF_ADAPTER_ID } from "../lib/discovery/adapters/gleif";
import { runDiscovery } from "../lib/discovery/run";

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.T003_TEST_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 3 });

const fx = (name: string): unknown =>
  JSON.parse(readFileSync(`tests/fixtures/gleif/${name}`, "utf8"));

type Route = { status: number; json?: unknown; headers?: Record<string, string> };
function mockFetch(routes: Route[] | ((url: string, call: number) => Route)) {
  let calls = 0;
  const seen: string[] = [];
  const impl = async (url: string | URL | Request): Promise<Response> => {
    calls += 1;
    const u = String(url);
    seen.push(u);
    const r = typeof routes === "function" ? routes(u, calls) : routes[Math.min(calls - 1, routes.length - 1)];
    return new Response(
      r.json === undefined ? "not-json{{{" : JSON.stringify(r.json),
      { status: r.status, headers: r.headers },
    );
  };
  return { impl: impl as typeof fetch, calls: () => calls, seen: () => seen };
}

const adapter = (fetchImpl?: typeof fetch) => new GleifAdapter(fetchImpl ? { fetchImpl } : {});
const regWith = (fetchImpl?: typeof fetch) => {
  const r = new AdapterRegistry();
  r.register(new GleifAdapter(fetchImpl ? { fetchImpl } : {}));
  return r;
};

describe("gleif adapter contract", () => {
  it("declares id, category, capabilities, and keyless access", () => {
    const m = new GleifAdapter().manifest();
    expect(m).toMatchObject({
      id: GLEIF_ADAPTER_ID,
      category: "S-02",
      version: "0.1.0",
      maxPageSize: 25,
    });
    expect(m.capabilities).toContain("discover");
    expect(m.accessRequirements).toMatch(/no key/i);
    expect(m.limitations.join(" ")).toMatch(/no sector data/i);
  });

  it("validates config (empty ok; secrets/unknown rejected)", () => {
    expect(new GleifAdapter().validateConfig({})).toEqual({ ok: true });
    const bad = new GleifAdapter().validateConfig({ apiKey: "SECRET-XYZ" });
    expect(bad.ok).toBe(false);
  });

  it("maps real records with provenance, flags gaps, never invents", async () => {
    const { impl } = mockFetch([{ status: 200, json: fx("search-ok.json") }]);
    const out = await adapter(impl).discover({ text: "KOTZILLA", limit: 2 }, { config: {} });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.records).toHaveLength(2);
    const n = adapter().normalize(out.records[0], adapter().manifest());
    expect(n).toMatchObject({
      adapterId: GLEIF_ADAPTER_ID,
      registryId: "98450079C9148C2F5B36",
      registryType: "lei",
      country: "FR",
      countryCode: "FR",
      agencyType: "other_digital",
    });
    expect(n.missingFields).toContain("domain");
    expect(n.warnings.join(" ")).toMatch(/no sector data/);
    expect(out.records[0].url).toMatch(/^https:\/\/api\.gleif\.org\//);
    // Inactive entity is kept with an explicit warning (observation, not verdict).
    const n2 = adapter().normalize(out.records[1], adapter().manifest());
    expect(n2.warnings.join(" ")).toMatch(/INACTIVE/);
  });

  it("returns empty for empty result sets", async () => {
    const { impl } = mockFetch([{ status: 200, json: fx("search-empty.json") }]);
    const out = await adapter(impl).discover({ text: "zzz-no-match", limit: 5 }, { config: {} });
    expect(out).toEqual({ kind: "empty", page: { nextPageToken: null } });
  });

  it("walks continuation tokens across pages", async () => {
    const { impl } = mockFetch([
      { status: 200, json: fx("search-page1.json") },
      { status: 200, json: fx("search-page2.json") },
    ]);
    const a = adapter(impl);
    const p1 = await a.discover({ text: "Q", limit: 2 }, { config: {} });
    expect(p1.kind).toBe("ok");
    if (p1.kind !== "ok") return;
    expect(p1.partial).toBe(true);
    expect(p1.page.nextPageToken).toBe("2");
    const p2 = await a.discover({ text: "Q", limit: 2, pageToken: p1.page.nextPageToken! }, { config: {} });
    expect(p2.kind).toBe("ok");
    if (p2.kind !== "ok") return;
    expect(p2.partial).toBe(false);
    expect(p2.page.nextPageToken).toBeNull();
    expect(p2.records).toHaveLength(1);
  });

  it("tolerates malformed records without throwing", async () => {
    const { impl } = mockFetch([{ status: 200, json: fx("malformed.json") }]);
    const out = await adapter(impl).discover({ text: "Q", limit: 5 }, { config: {} });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.records).toHaveLength(2);
    const a = adapter();
    const n0 = a.normalize(out.records[0], a.manifest());
    expect(n0.sourceRecordId).toBe("unknown");
    expect(n0.missingFields.length).toBeGreaterThan(0);
  });

  it("rejects empty queries without fetching", async () => {
    const { impl, calls } = mockFetch([{ status: 200, json: fx("search-empty.json") }]);
    const out = await adapter(impl).discover({ text: "   ", limit: 5 }, { config: {} });
    expect(out).toMatchObject({ kind: "failed", cause: "misconfigured", retryable: false });
    expect(calls()).toBe(0);
  });
});

describe("gleif failure mapping + retries", () => {
  it("retries 429 then succeeds", async () => {
    const { impl, calls } = mockFetch([
      { status: 429, json: { title: "limited" } },
      { status: 200, json: fx("search-empty.json") },
    ]);
    const out = await adapter(impl).discover({ text: "Q", limit: 2 }, { config: {} });
    expect(out.kind).toBe("empty");
    expect(calls()).toBe(2);
  });

  it("gives up after bounded retries with retryable failure", async () => {
    const { impl, calls } = mockFetch([
      { status: 429, json: {} },
      { status: 429, json: {} },
      { status: 429, json: {} },
    ]);
    const out = await adapter(impl).discover({ text: "Q", limit: 2 }, { config: {} });
    expect(out).toMatchObject({ kind: "failed", cause: "rate_limited", retryable: true });
    expect(calls()).toBe(3); // initial + 2 bounded retries
  });

  it("retries 500s, never retries 400/403, redacts bodies", async () => {
    const err = { status: 500, json: { leaked: "SECRET-XYZ-bleed" } };
    const { impl } = mockFetch([err, err, err]);
    const out = await adapter(impl).discover({ text: "Q", limit: 2 }, { config: {} });
    expect(out).toMatchObject({ kind: "failed", cause: "network", retryable: true });
    expect(JSON.stringify(out)).not.toMatch(/SECRET-XYZ/);

    const bad = mockFetch([{ status: 400, json: {} }]);
    const out400 = await adapter(bad.impl).discover({ text: "Q", limit: 2 }, { config: {} });
    expect(out400).toMatchObject({ kind: "failed", cause: "misconfigured", retryable: false });
    expect(bad.calls()).toBe(1);

    const denied = mockFetch([{ status: 403, json: {} }]);
    const out403 = await adapter(denied.impl).discover({ text: "Q", limit: 2 }, { config: {} });
    expect(out403).toMatchObject({ kind: "failed", cause: "terms_block", retryable: false });
  });

  it("honors cancellation", async () => {
    const { impl } = mockFetch([{ status: 200, json: fx("search-ok.json") }]);
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await adapter(impl).discover({ text: "Q", limit: 2 }, { config: {}, signal: ctrl.signal });
    expect(out).toMatchObject({ kind: "failed", cause: "cancelled" });
  });
});

describe("ssrf + redirect policy", () => {
  it("only ever calls the fixed https API host", async () => {
    const { impl, seen } = mockFetch([{ status: 200, json: fx("search-empty.json") }]);
    await adapter(impl).discover({ text: "Q", limit: 2 }, { config: {} });
    expect(seen().length).toBeGreaterThan(0);
    for (const u of seen()) {
      expect(u.startsWith("https://api.gleif.org/")).toBe(true);
    }
  });

  it("follows same-host https redirects, blocks the rest", async () => {
    const hop = (status: number, location?: string): Route => ({
      status,
      json: {},
      ...(location ? { headers: { Location: location } } : {}),
    });
    // Same-host https redirect → followed to a good page.
    const ok = mockFetch([
      hop(302, "https://api.gleif.org/api/v1/lei-records?page%5Bsize%5D=1"),
      { status: 200, json: fx("search-empty.json") },
    ]);
    const r1 = await adapter(ok.impl).discover({ text: "Q", limit: 1 }, { config: {} });
    expect(r1.kind).toBe("empty");
    // Cross-host redirect → blocked, permanent.
    const evil = mockFetch([hop(302, "https://evil.example/collect")]);
    const r2 = await adapter(evil.impl).discover({ text: "Q", limit: 1 }, { config: {} });
    expect(r2).toMatchObject({ kind: "failed", cause: "terms_block", retryable: false });
    // Downgrade redirect → blocked.
    const down = mockFetch([hop(302, "http://api.gleif.org/api/v1/lei-records")]);
    const r3 = await adapter(down.impl).discover({ text: "Q", limit: 1 }, { config: {} });
    expect(r3).toMatchObject({ kind: "failed", cause: "terms_block", retryable: false });
  });
});

describe("discovery runs (persistence + identity handoff)", () => {
  afterEach(async () => {
    const c = await pool.connect();
    try {
      await c.query("delete from public.discovery_run where created_by = 't6test'");
      // Fixture-created companies keep source-given names (that's the point),
      // so clean by known fixture LEIs plus t6 markers.
      await c.query(
        `delete from public.company where domain_norm like 't6-%' or name like 'T6 %'
         or registry_id in ('98450079C9148C2F5B36','213800AAEC5PINRZE471',
           'AAAAAAAAAAAAAAAAAAAA01','AAAAAAAAAAAAAAAAAAAA02','AAAAAAAAAAAAAAAAAAAA03',
           'BBBBBBBBBBBBBBBBBB01')`,
      );
    } finally {
      c.release();
    }
  });

  function mockSource(pages: unknown[]) {
    let n = 0;
    return {
      impl: (async (url: string | URL | Request): Promise<Response> => {
        n += 1;
        void url;
        return new Response(JSON.stringify(pages[Math.min(n - 1, pages.length - 1)]), {
          status: 200,
        });
      }) as typeof fetch,
    };
  }

  it("persists runs, creates companies, skips invalid, and reruns idempotently", async () => {
    const reg = new AdapterRegistry();
    reg.register(new GleifAdapter({ fetchImpl: mockSource([fx("search-ok.json")]).impl }));
    const first = await runDiscovery(pool, reg, {
      adapterId: GLEIF_ADAPTER_ID,
      queryText: "KOTZILLA",
      limit: 5,
      maxPages: 1,
      actor: "t6test",
    });
    expect(first.status).toBe("ok");
    // KOTZILLA valid (FR + LEI); synthetic inactive record lacks... has GB.
    // Both carry country + LEI: both valid creations.
    expect(first.counts).toMatchObject({ found: 2, new: 2 });
    expect(first.items).toHaveLength(2);
    // Rerun: stable identity → duplicates, zero new companies.
    const reg2 = new AdapterRegistry();
    reg2.register(new GleifAdapter({ fetchImpl: mockSource([fx("search-ok.json")]).impl }));
    const second = await runDiscovery(pool, reg2, {
      adapterId: GLEIF_ADAPTER_ID,
      queryText: "KOTZILLA",
      limit: 5,
      maxPages: 1,
      actor: "t6test",
    });
    expect(second.status).toBe("ok");
    expect(second.counts).toMatchObject({ found: 2, duplicates: 2, new: 0 });
    const c = await pool.connect();
    try {
      const n = await c.query(
        "select count(*)::int as n from public.company where registry_id in ('98450079C9148C2F5B36','213800AAEC5PINRZE471')",
      );
      expect(n.rows[0].n).toBe(2);
    } finally {
      c.release();
    }
  });

  it("routes canonical conflicts to human review (never merges, never overwrites)", async () => {
    // Pre-existing canonical record holding the same LEI.
    const existing = await createCompany(
      pool,
      {
        name: "T6 Existing Holder",
        domain: "t6-holder.example",
        registryId: "98450079C9148C2F5B36",
        registryType: "lei",
        agencyType: "web_development",
        country: "France",
        countryCode: "FR",
      },
      "t6test",
    );
    const reg = new AdapterRegistry();
    reg.register(
      new GleifAdapter({
        fetchImpl: mockSource([
          {
            meta: {},
            links: {},
            data: [
              {
                type: "lei-records",
                id: "98450079C9148C2F5B36",
                attributes: {
                  lei: "98450079C9148C2F5B36",
                  entity: {
                    legalName: { name: "KOTZILLA" },
                    legalAddress: { country: "FR" },
                    jurisdiction: "FR",
                    status: "ACTIVE",
                  },
                },
                links: { self: "https://api.gleif.org/api/v1/lei-records/98450079C9148C2F5B36" },
              },
            ],
          },
        ]).impl,
      }),
    );
    const res = await runDiscovery(pool, reg, {
      adapterId: GLEIF_ADAPTER_ID,
      queryText: "KOTZILLA",
      limit: 5,
      maxPages: 1,
      actor: "t6test",
    });
    expect(res.counts).toMatchObject({ found: 1, conflicts: 1, new: 0 });
    expect(res.items[0].candidateId).not.toBeNull();
    // Established record untouched (name + domain intact, still canonical).
    const c = await pool.connect();
    try {
      const r = await c.query(
        "select name, domain_norm, merged_into from public.company where id = $1",
        [existing.companyId],
      );
      expect(r.rows[0]).toMatchObject({
        name: "T6 Existing Holder",
        domain_norm: "t6-holder.example",
        merged_into: null,
      });
    } finally {
      c.release();
    }
  });

  it("records adapter failures on the run without leaking bodies", async () => {
    // NOTE: mockSource above ignores per-route status; build a failing mock:
    const failing = async (): Promise<Response> =>
      new Response(JSON.stringify({ oops: "SECRET-XYZ" }), { status: 500 });
    const reg2 = new AdapterRegistry();
    reg2.register(new GleifAdapter({ fetchImpl: failing as typeof fetch }));
    const res = await runDiscovery(pool, reg2, {
      adapterId: GLEIF_ADAPTER_ID,
      queryText: "QXYZ",
      limit: 2,
      maxPages: 1,
      actor: "t6test",
    });
    expect(res.status).toBe("failed");
    expect(res.error ?? "").not.toMatch(/SECRET-XYZ/);
    const c = await pool.connect();
    try {
      const r = await c.query("select error from public.discovery_run where id = $1", [res.runId]);
      expect(r.rows[0].error ?? "").not.toMatch(/SECRET-XYZ/);
    } finally {
      c.release();
    }
  });

  it("counts accurate on partial multi-page runs", async () => {
    const reg = new AdapterRegistry();
    reg.register(
      new GleifAdapter({
        fetchImpl: mockSource([fx("search-page1.json"), fx("search-page2.json")]).impl,
      }),
    );
    const res = await runDiscovery(pool, reg, {
      adapterId: GLEIF_ADAPTER_ID,
      queryText: "Q",
      limit: 2,
      maxPages: 1,
      actor: "t6test",
    });
    // maxPages=1 with more pages available -> partial, only page 1 processed.
    expect(res.status).toBe("partial");
    expect(res.counts).toMatchObject({ found: 2, new: 2 });
  });
});

describe("discovery route authorization (static contract)", () => {
  it("mutating run endpoint enforces session auth plus CSRF (AUTH-001)", () => {
    const src = readFileSync("app/api/discovery/runs/route.ts", "utf8");
    // Session-first centralized guard; the legacy open-mode bearer check is gone.
    expect(src).toMatch(/requireOperatorApi\(req\)/);
    expect(src).toMatch(/requireSameOrigin\(req, auth\)/);
    expect(src).not.toMatch(/checkOperatorToken/);
  });
});

// Live smoke: bounded, keyless, public open-data API. Opt-in only —
// the suite never depends on the network.
const live = process.env.GLEIF_LIVE_SMOKE === "1" ? it : it.skip;
live("live smoke: real GLEIF search returns keyed records", async () => {
  const a = new GleifAdapter();
  const out = await a.discover({ text: "KOTZILLA", limit: 2 }, { config: {} });
  expect(out.kind).toBe("ok");
  if (out.kind !== "ok") return;
  expect(out.records.length).toBeGreaterThanOrEqual(1);
  const first = out.records[0];
  expect(first.sourceRecordId).toMatch(/^[0-9A-Z]{20}$/);
  expect(first.url).toMatch(/^https:\/\/api\.gleif\.org\//);
  const n = a.normalize(first, a.manifest());
  expect(n.registryType).toBe("lei");
}, 60_000);
