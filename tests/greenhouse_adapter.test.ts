/**
 * Phase 2: Greenhouse Job Board adapter + hardened fetch transport.
 *
 * Offline: every HTTP path goes through an injected `fetchImpl`. Fixtures are
 * the REAL response shapes (documented at developers.greenhouse.io/job-board.html
 * and verified by one live read-only probe on 2026-10-16). No test enables the
 * production source and no test touches a non-test database.
 */
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../lib/discovery/registry";
import { fetchJson, parseRetryAfter } from "../lib/discovery/http";
import {
  GREENHOUSE_ADAPTER_ID,
  GreenhouseAdapter,
  isBoardToken,
  jobRecordId,
} from "../lib/discovery/adapters/greenhouse";
import type { DiscoveryQuery, RawRecord } from "../lib/discovery/types";

const fx = (name: string): unknown =>
  JSON.parse(readFileSync(`tests/fixtures/greenhouse/${name}`, "utf8"));

type RouteObj = {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
  body?: string;
};
type Route = RouteObj | ((url: string, call: number) => RouteObj);

function mockFetch(routes: Route) {
  let calls = 0;
  const seen: string[] = [];
  const impl = async (url: string | URL | Request): Promise<Response> => {
    calls += 1;
    const u = String(url);
    seen.push(u);
    const r = typeof routes === "function" ? routes(u, calls) : routes;
    const body = r.body !== undefined ? r.body : JSON.stringify(r.json);
    return new Response(body, { status: r.status, headers: r.headers });
  };
  return { impl: impl as typeof fetch, calls: () => calls, seen: () => seen };
}

const okHeaders = { "content-type": "application/json" };
const adapter = (impl?: typeof fetch) =>
  new GreenhouseAdapter(impl ? { fetchImpl: impl } : {});
const reg = (impl?: typeof fetch) => {
  const r = new AdapterRegistry();
  r.register(adapter(impl));
  return r;
};
const q = (over: Partial<DiscoveryQuery> = {}): DiscoveryQuery => ({ text: "greenhouse", ...over });

describe("greenhouse manifest and contract", () => {
  it("declares the approved S-07 category, a disabled source key, and no credentials", () => {
    const m = adapter().manifest();
    expect(m).toMatchObject({
      id: GREENHOUSE_ADAPTER_ID,
      category: "S-07",
      sourceKey: "greenhouse-job-board",
      version: "0.1.0",
    });
    expect(m.capabilities).toContain("discover");
    expect(m.accessRequirements).toMatch(/no key/i);
    expect(m.limitations.join(" ")).toMatch(/never proof of intent to subcontract/i);
    expect(m.limitations.join(" ")).toMatch(/tenant-scoped/);
  });

  it("takes no configuration and refuses anything resembling a secret", () => {
    expect(adapter().validateConfig({})).toEqual({ ok: true });
    const bad = adapter().validateConfig({ apiKey: "SECRET-XYZ" });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).toContain("apiKey");
    expect(JSON.stringify(bad)).not.toContain("SECRET-XYZ");
  });

  it("registers and lists passively without any network access", async () => {
    const spy = mockFetch({ status: 200, json: fx("jobs-ok.json"), headers: okHeaders });
    const r = reg(spy.impl);
    expect(r.ids()).toEqual([GREENHOUSE_ADAPTER_ID]);
    const [listed] = r.list();
    expect(listed).toMatchObject({ category: "S-07", contractVersion: 1 });
    expect(JSON.stringify(listed)).not.toMatch(/apiKey|secret|password/i);
    expect(await r.checkHealth(GREENHOUSE_ADAPTER_ID, {})).toBe(true);
    expect(spy.calls()).toBe(0);
  });

  it("treats the query text as a board token, not a search string", async () => {
    expect(isBoardToken("greenhouse")).toBe(true);
    expect(isBoardToken("acme-agency_1")).toBe(true);
    for (const bad of ["", " ", "a".repeat(65), "acme agency", "acme/agency", "http://x"]) {
      expect(isBoardToken(bad), bad).toBe(false);
    }
    const r = reg(mockFetch({ status: 200, json: fx("jobs-ok.json"), headers: okHeaders }).impl);
    for (const bad of ["", "a".repeat(65), "acme agency", "acme/agency"]) {
      const out = await r.discover(GREENHOUSE_ADAPTER_ID, { text: bad }, {});
      expect(out, bad).toMatchObject({ kind: "failed", cause: "misconfigured", retryable: false });
    }
  });

  it("never exposes arbitrary hosts: only the fixed API host is requested", async () => {
    const spy = mockFetch({ status: 200, json: fx("jobs-ok.json"), headers: okHeaders });
    await reg(spy.impl).discover(GREENHOUSE_ADAPTER_ID, q(), {});
    for (const url of spy.seen()) {
      expect(url.startsWith("https://boards-api.greenhouse.io/v1/boards/")).toBe(true);
    }
  });
});

describe("greenhouse discovery: normalization and provenance", () => {
  it("normalizes documented job records with tenant-scoped ids and real dates", async () => {
    const r = reg(mockFetch({ status: 200, json: fx("jobs-ok.json"), headers: okHeaders }).impl);
    const out = await r.discover(GREENHOUSE_ADAPTER_ID, q(), {});
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.records).toHaveLength(3);
    expect(out.page.nextPageToken).toBeNull();
    expect(out.partial).toBe(false);

    const a = adapter();
    const first = a.normalizeJob(out.records[0])!;
    expect(first).toMatchObject({
      boardToken: "greenhouse",
      jobId: "8126988",
      title: "Commercial Counsel",
      location: "Eastern Timezone",
      requisitionId: "2026 - P3178",
    });
    // Source dates are normalized to ISO and kept distinct from retrieval.
    expect(first.publishedAt).toBe("2026-08-24T17:52:04.000Z");
    expect(first.updatedAt).toBe("2026-10-09T22:28:27.000Z");
    expect(first.publishedAt).not.toBe(out.records[0].retrievedAt);

    // Provenance keeps the human-facing posting URL, not the API URL.
    expect(out.records[0].url).toBe(
      "https://job-boards.greenhouse.io/greenhouse/jobs/8126988?gh_jid=8126988",
    );
    expect(out.records[0].sourceRecordId).toBe("greenhouse:8126988");
    expect(jobRecordId("acme", 42)).toBe("acme:42");
    // Two tenants can both have job id 1; ids must not collide.
    expect(jobRecordId("a", 1)).not.toBe(jobRecordId("b", 1));

    const prov = a.provenance(out.records[0], a.manifest());
    expect(prov).toMatchObject({
      adapterId: GREENHOUSE_ADAPTER_ID,
      sourceRecordId: "greenhouse:8126988",
      sourceCategory: "S-07",
    });
  });

  it("keeps missing source fields null and declares them; never defaults a date", async () => {
    const r = reg(mockFetch({ status: 200, json: fx("jobs-ok.json"), headers: okHeaders }).impl);
    const out = await r.discover(GREENHOUSE_ADAPTER_ID, q(), {});
    if (out.kind !== "ok") return;
    const a = adapter();
    const noDates = a.normalizeJob(out.records[1])!;
    expect(noDates.publishedAt).toBeNull();
    expect(noDates.requisitionId).toBeNull();
    expect(noDates.missingFields).toContain("first_published");
    expect(noDates.missingFields).toContain("requisition_id");

    const noLocation = a.normalizeJob(out.records[2])!;
    expect(noLocation.location).toBeNull();
    expect(noLocation.missingFields).toContain("location");
    // A prospect post (internal_job_id null) is still a posting, not a role.
    expect(noLocation.title).toBe("Prospect");
    // Custom metadata is never surfaced into the payload used for evidence.
    expect(JSON.stringify(noLocation)).not.toMatch(/Referral/);
  });

  it("contract normalize never presents a job posting as a company", () => {
    const a = adapter();
    const raw: RawRecord = {
      sourceRecordId: "greenhouse:1",
      url: "https://job-boards.greenhouse.io/greenhouse/jobs/1",
      retrievedAt: "2026-10-16T00:00:00.000Z",
      payload: {
        id: "1", board_token: "greenhouse", title: "Engineer",
        absolute_url: "https://job-boards.greenhouse.io/greenhouse/jobs/1",
      },
    };
    const n = a.normalize(raw, a.manifest());
    expect(n.name).toBe("job posting: Engineer");
    expect(n.country).toBe("(unknown)");
    expect(n.domain).toBeUndefined();
    expect(n.registryId).toBeUndefined();
    expect(n.missingFields).toContain("company_identity");
    expect(n.warnings.join(" ")).toMatch(/must not create or merge a company/);
  });

  it("survives hostile payloads: drops unusable records, never trusts them", async () => {
    const r = reg(mockFetch({ status: 200, json: fx("jobs-hostile.json"), headers: okHeaders }).impl);
    const out = await r.discover(GREENHOUSE_ADAPTER_ID, q(), {});
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    const a = adapter();
    const signals = out.records.map((x) => a.normalizeJob(x)).filter((x) => x !== null);
    // Records with no id or no title are dropped rather than fabricated.
    expect(signals.map((s) => s!.jobId)).toEqual(["900002", "900003", "900004"]);
    const loopback = signals.find((s) => s!.jobId === "900002")!;
    // A loopback absolute_url is replaced with the canonical API record URL.
    expect(loopback.canonicalUrl).toBe(
      "https://boards-api.greenhouse.io/v1/boards/greenhouse/jobs/900002",
    );
    expect(loopback.canonicalUrl).not.toMatch(/127\.0\.0\.1|5434/);
    // An unparseable date stays null and is declared missing.
    expect(loopback.updatedAt).toBeNull();
    expect(loopback.missingFields).toContain("updated_at");
    // Personal data in metadata never reaches the normalized signal.
    expect(JSON.stringify(signals)).not.toMatch(/jane\.smith/);
    // An implausibly long source field is dropped and declared missing, not
    // passed through into an excerpt.
    const longRequisition = signals.find((s) => s!.jobId === "900004")!;
    expect(longRequisition.requisitionId).toBeNull();
    expect(longRequisition.missingFields).toContain("requisition_id");
    // Every record still warns that a posting is not subcontract intent.
    for (const s of signals)
      expect(s!.warnings.join(" ")).toMatch(/not proof of subcontract intent/);
  });

  it("drops a record whose title exceeds the bound instead of truncating it", async () => {
    const huge = {
      jobs: [
        { id: 1, title: "Engineer ".repeat(100), absolute_url: "https://job-boards.greenhouse.io/x/jobs/1" },
      ],
      meta: { total: 1 },
    };
    const r = reg(mockFetch({ status: 200, json: huge, headers: okHeaders }).impl);
    expect(await r.discover(GREENHOUSE_ADAPTER_ID, q(), {})).toEqual({
      kind: "empty", page: { nextPageToken: null },
    });
  });

  it("returns empty for a board with no postings and fails closed on bad shapes", async () => {
    const empty = await reg(
      mockFetch({ status: 200, json: fx("jobs-empty.json"), headers: okHeaders }).impl,
    ).discover(GREENHOUSE_ADAPTER_ID, q(), {});
    expect(empty).toEqual({ kind: "empty", page: { nextPageToken: null } });

    const bad = await reg(
      mockFetch({ status: 200, json: fx("jobs-unexpected-shape.json"), headers: okHeaders }).impl,
    ).discover(GREENHOUSE_ADAPTER_ID, q(), {});
    expect(bad).toMatchObject({ kind: "failed", cause: "parse", retryable: false });
  });
});

describe("greenhouse discovery: local paging and run bounds", () => {
  it("pages locally with an offset token and reports exhaustion honestly", async () => {
    const { impl, calls } = mockFetch({ status: 200, json: fx("jobs-ok.json"), headers: okHeaders });
    const r = reg(impl);
    const p1 = await r.discover(GREENHOUSE_ADAPTER_ID, q({ limit: 2 }), {});
    expect(p1.kind).toBe("ok");
    if (p1.kind !== "ok") return;
    expect(p1.records).toHaveLength(2);
    expect(p1.partial).toBe(true);
    expect(p1.page.nextPageToken).toBe("2");

    const p2 = await r.discover(
      GREENHOUSE_ADAPTER_ID, q({ limit: 2, pageToken: p1.page.nextPageToken! }), {},
    );
    expect(p2.kind).toBe("ok");
    if (p2.kind !== "ok") return;
    expect(p2.records).toHaveLength(1);
    expect(p2.partial).toBe(false);
    expect(p2.page.nextPageToken).toBeNull();
    // Local paging re-fetches the board response; ids must not overlap.
    const ids = [...p1.records, ...p2.records].map((x) => x.sourceRecordId);
    expect(new Set(ids).size).toBe(3);
    expect(calls()).toBe(2);

    const past = await r.discover(GREENHOUSE_ADAPTER_ID, q({ limit: 2, pageToken: "999" }), {});
    expect(past).toEqual({ kind: "empty", page: { nextPageToken: null } });
  });

  it("clamps the requested limit to the declared maximum", async () => {
    const spy = mockFetch({ status: 200, json: fx("jobs-ok.json"), headers: okHeaders });
    await reg(spy.impl).discover(GREENHOUSE_ADAPTER_ID, q({ limit: 100_000 }), {});
    // 3 records exist; the clamp cannot inflate a page beyond them.
    const again = mockFetch({ status: 200, json: fx("jobs-ok.json"), headers: okHeaders });
    await reg(again.impl).discover(GREENHOUSE_ADAPTER_ID, q({ limit: 1 }), {});
    expect(spy.calls()).toBe(1);
  });
});

describe("greenhouse error mapping", () => {
  it("maps a 404 board token to a permanent, non-retryable configuration error", async () => {
    const { impl, calls } = mockFetch({ status: 404, body: "" });
    const out = await reg(impl).discover(GREENHOUSE_ADAPTER_ID, q(), {});
    expect(out).toMatchObject({ kind: "failed", cause: "misconfigured", retryable: false });
    expect((out as { message: string }).message).toMatch(/board token not found/i);
    expect(calls()).toBe(1); // no retry storm on a permanent error
  });

  it("maps 403 to a terms refusal and 401/403 never retry", async () => {
    for (const status of [401, 403]) {
      const { impl, calls } = mockFetch({ status });
      const out = await reg(impl).discover(GREENHOUSE_ADAPTER_ID, q(), {});
      expect(out, String(status)).toMatchObject({
        kind: "failed", cause: "terms_block", retryable: false,
      });
      expect(calls()).toBe(1);
    }
  });

  it("retries 429 within a bound and honours Retry-After without leaking bodies", async () => {
    const { impl, calls } = mockFetch({
      status: 429, body: "SECRET-BODY-MUST-NOT-LEAK",
      headers: { "retry-after": "0" },
    });
    const out = await reg(impl).discover(GREENHOUSE_ADAPTER_ID, q(), {});
    expect(out).toMatchObject({ kind: "failed", cause: "rate_limited", retryable: true });
    // MAX_RETRIES = 2 -> one initial call plus two retries, then give up.
    expect(calls()).toBe(3);
    expect(JSON.stringify(out)).not.toMatch(/SECRET-BODY/);
  });

  it("recovers when a transient 5xx is followed by a good response", async () => {
    let n = 0;
    const { impl, calls } = mockFetch(() => {
      n += 1;
      return n === 1
        ? { status: 503, body: "", headers: { "retry-after": "0" } }
        : { status: 200, json: fx("jobs-ok.json"), headers: okHeaders };
    });
    const out = await reg(impl).discover(GREENHOUSE_ADAPTER_ID, q(), {});
    expect(out.kind).toBe("ok");
    expect(calls()).toBe(2);
  });

  it("refuses an oversized body and a non-JSON content-type without buffering", async () => {
    // Declared JSON, actual 50 KB: the cap must trip while reading.
    const big = await fetchJson("https://boards-api.greenhouse.io/x", {
      maxBytes: 2048,
      fetchImpl: mockFetch({
        status: 200, body: "x".repeat(50_000), headers: { "content-type": "application/json" },
      }).impl,
    });
    expect(big).toMatchObject({ ok: false, kind: "too_large" });
    expect((big as { message: string }).message).toMatch(/aborted while reading/);

    const html = await fetchJson("https://boards-api.greenhouse.io/x", {
      fetchImpl: mockFetch({
        status: 200, body: "<html>login</html>", headers: { "content-type": "text/html" },
      }).impl,
    });
    expect(html).toMatchObject({ ok: false, kind: "bad_content_type" });
    expect((html as { message: string }).message).not.toMatch(/login/);
  });

  it("enforces a per-request timeout and honours cancellation", async () => {
    const slow = (): Promise<Response> => new Promise((_res, rej) => {
      setTimeout(() => rej(new Error("socket open")), 5000).unref?.();
    });
    const timedOut = await fetchJson("https://boards-api.greenhouse.io/x", {
      timeoutMs: 40, fetchImpl: slow as unknown as typeof fetch,
    });
    expect(timedOut).toMatchObject({ ok: false, kind: "network" });
    expect((timedOut as { message: string }).message).toMatch(/exceeded 40ms/);

    const ctrl = new AbortController();
    ctrl.abort();
    const cancelled = await fetchJson("https://boards-api.greenhouse.io/x", { signal: ctrl.signal });
    expect(cancelled).toMatchObject({ ok: false, kind: "cancelled" });
  });

  it("blocks cross-host and private redirects", async () => {
    const evil = await fetchJson("https://boards-api.greenhouse.io/x", {
      fetchImpl: mockFetch({
        status: 302, body: "", headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }).impl,
    });
    expect(evil).toMatchObject({ ok: false, kind: "redirect_blocked" });

    const offHost = await fetchJson("https://boards-api.greenhouse.io/x", {
      fetchImpl: mockFetch({
        status: 302, body: "", headers: { location: "https://evil.example/steal" },
      }).impl,
    });
    expect(offHost).toMatchObject({ ok: false, kind: "redirect_blocked" });
  });

  it("keeps the body cap from being disabled by an absurd caller value", async () => {
    const tiny = await fetchJson("https://boards-api.greenhouse.io/x", {
      maxBytes: 1,
      fetchImpl: mockFetch({ status: 200, json: fx("jobs-ok.json"), headers: okHeaders }).impl,
    });
    expect(tiny).toMatchObject({ ok: false, kind: "too_large" });
  });
});

describe("Retry-After parsing", () => {
  it("accepts delta-seconds and HTTP-dates, rejecting nonsense", () => {
    const now = Date.parse("2026-10-16T00:00:00Z");
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("99999")).toBe(300); // capped
    expect(parseRetryAfter("Fri, 16 Oct 2026 00:00:20 GMT", now)).toBe(20);
    expect(parseRetryAfter("Fri, 16 Oct 2026 00:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter("-5")).toBeUndefined();
  });
});

// Live smoke: bounded, keyless, read-only, ONE request. Opt-in only — the
// deterministic suite never depends on the network. It calls discover()
// directly and therefore does NOT enable the source, does NOT touch any
// database, and does NOT require the licensing decision in
// docs/P2_SOURCE_SELECTION.md §5 (that decision gates ingestion runs, not a
// read of an already-public page).
const live = process.env.GREENHOUSE_LIVE_SMOKE === "1" ? it : it.skip;
live("live smoke: a public board returns dated, tenant-scoped job records", async () => {
  const a = new GreenhouseAdapter();
  const out = await a.discover({ text: "greenhouse", limit: 3 }, { config: {} });
  expect(out.kind).toBe("ok");
  if (out.kind !== "ok") return;
  expect(out.records.length).toBeGreaterThanOrEqual(1);
  const first = out.records[0];
  expect(first.sourceRecordId).toMatch(/^greenhouse:\d+$/);
  expect(first.url).toMatch(/^https:\/\//);
  expect(Date.parse(first.retrievedAt)).not.toBeNaN();
  const s = a.normalizeJob(first);
  expect(s).not.toBeNull();
  expect(s!.title.length).toBeGreaterThan(0);
  // The source states first_published; when present it must be a real date.
  if (s!.publishedAt !== null) expect(Date.parse(s!.publishedAt)).not.toBeNaN();
  expect(s!.warnings.join(" ")).toMatch(/not proof of subcontract intent/);
}, 60_000);