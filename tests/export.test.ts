/**
 * Phase 3: export safety + directory filtering/pagination/parity.
 *
 * Two properties are load-bearing here:
 *   1. The export must contain EXACTLY what the operator's screen shows —
 *      proven by driving the same filter parser into both and comparing.
 *   2. Untrusted text must never leave the system in a form a spreadsheet
 *      will execute. Proven against real injection vectors, not descriptions.
 *
 * Isolated test database; no production source is enabled.
 */
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { ingestObservation } from "../lib/evidence/ingest";
import {
  AGENCY_EXPORT_COLUMNS,
  csvCell,
  isFormulaLike,
  toCsv,
} from "../lib/export/csv";
import {
  fetchAgencyDirectory,
  fetchAgencyRowsForExport,
  parseAgencyFilters,
  MAX_PER_PAGE,
} from "../lib/dashboard/agency-query";
import { GET as exportGET } from "../app/api/export/route";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
process.env.DATABASE_URL = DB_URL;
const pool = new Pool({ connectionString: DB_URL, max: 4 });
const ACTOR = "p3export";
const ORIGIN = "http://127.0.0.1:3101";
const OPERATOR = "p3export-operator@example.com";
let token = "";

async function cleanup(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(
      "delete from public.claim where company_id in (select id from public.company where domain_norm like 'p3exp-%')",
    );
    await c.query(
      "delete from public.snapshot where company_id in (select id from public.company where domain_norm like 'p3exp-%')",
    );
    await c.query("delete from public.company where domain_norm like 'p3exp-%'");
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await cleanup();
  const { createSession } = await import("../lib/auth/sessions");
  const { getAuthConfig } = await import("../lib/auth/config");
  const cfg = getAuthConfig({ ...process.env, NODE_ENV: "test", OPERATOR_EMAIL: OPERATOR });
  token = (await createSession(pool, { ...cfg, sessionTtlSec: 3600 }, OPERATOR)).rawToken;
});

afterEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await pool.query("delete from public.operator_session where operator_email = $1", [OPERATOR]);
  await pool.end();
});

function seed(tag: string, over: Record<string, unknown> = {}): Promise<{ companyId: string }> {
  return createCompany(
    pool,
    {
      name: `P3exp ${tag} Ltd`,
      domain: `p3exp-${tag}-${Date.now()}.example`,
      agencyType: "web_development",
      country: "United Kingdom",
      ...over,
    },
    ACTOR,
  );
}

describe("CSV encoding safety", () => {
  it("neutralizes formula injection in every column", () => {
    for (const evil of [
      "=cmd|'/c calc'!A1",
      "+1+1",
      "-2+3",
      "@SUM(A1:A9)",
      "\t=1+1",
      "\r=1+1",
      "  =cmd|'/c calc'!A1", // leading whitespace is stripped for the test
    ]) {
      expect(isFormulaLike(evil), evil).toBe(true);
      // The cell must never present the value as executable. It may be quoted
      // (a leading tab/CR forces quoting), so strip an opening quote before
      // checking that the neutralising apostrophe directly precedes the
      // original payload.
      const cell = csvCell(evil).replace(/^"/, "").replace(/"$/, "");
      expect(cell, evil).toBe(`'${evil}`);
    }
    // Ordinary text and numbers must NOT be mangled.
    for (const safe of ["Acme Ltd", "web_development", "42", "2026-10-16", "a-b"]) {
      expect(isFormulaLike(safe), safe).toBe(false);
      expect(csvCell(safe).replace(/^"/, ""), safe).not.toContain("'");
    }
  });

  it("escapes quotes, commas, newlines and surrounding whitespace", () => {
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
    expect(csvCell(" padded ")).toBe('" padded "');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(false)).toBe("false");
    expect(csvCell(new Date("2026-10-16T00:00:00Z"))).toBe("2026-10-16T00:00:00.000Z");
  });

  it("builds an RFC 4180 document with a BOM, CRLF and stable headers", () => {
    const csv = toCsv(["a", "b"], [["1", "x,y"], ["2", 'q"r']]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe("a,b");
    expect(lines[1]).toBe('1,"x,y"');
    expect(lines[2]).toBe('2,"q""r"');
    // Trailing newline, as RFC 4180 expects.
    expect(csv.endsWith("\r\n")).toBe(true);
    // Column keys are unique and machine-stable.
    const keys = AGENCY_EXPORT_COLUMNS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of AGENCY_EXPORT_COLUMNS) expect(c.semantics.length).toBeGreaterThan(5);
  });

  it("an empty result set still produces a header-only document", () => {
    const csv = toCsv(["a", "b"], []);
    expect(csv.replace("\uFEFF", "").trim()).toBe("a,b");
  });
});

describe("directory query: filters, sort, pagination", () => {
  it("filters, sorts and paginates server-side with accurate totals", async () => {
    const a = await seed("alpha", { country: "United Kingdom" });
    const b = await seed("bravo", { country: "Germany" });
    const c = await seed("charlie", { country: "United Kingdom", agencyType: "mobile_app" });

    const uk = await fetchAgencyDirectory(
      pool,
      parseAgencyFilters(new URLSearchParams({ country: "United Kingdom", perPage: "50" })),
    );
    const ids = uk.rows.map((r) => r.id);
    expect(ids).toContain(a.companyId);
    expect(ids).toContain(c.companyId);
    expect(ids).not.toContain(b.companyId);
    expect(uk.total).toBe(ids.length);

    const typed = await fetchAgencyDirectory(
      pool,
      parseAgencyFilters(new URLSearchParams({ agencyType: "mobile_app" })),
    );
    expect(typed.rows.map((r) => r.id)).toContain(c.companyId);

    const byName = await fetchAgencyDirectory(
      pool,
      parseAgencyFilters(new URLSearchParams({ sort: "name", dir: "asc", perPage: "50" })),
    );
    const names = byName.rows.map((r) => r.name);
    expect([...names].sort()).toEqual(names);

    const p1 = await fetchAgencyDirectory(
      pool,
      parseAgencyFilters(new URLSearchParams({ perPage: "25", page: "1" })),
    );
    const p2 = await fetchAgencyDirectory(
      pool,
      parseAgencyFilters(new URLSearchParams({ perPage: "25", page: "2" })),
    );
    if (p1.pageCount > 1) {
      expect(p1.page).toBe(1);
      expect(p2.page).toBe(2);
      // Pages must not overlap.
      expect(p1.rows.some((r) => p2.rows.some((x) => x.id === r.id))).toBe(false);
    }
  });

  it("rejects hostile sort/page input instead of passing it to SQL", async () => {
    const co = await seed("hostile");
    const before = await pool.query("select count(*)::int n from public.company");
    const f = parseAgencyFilters(
      new URLSearchParams({
        sort: "name; drop table public.company--",
        dir: "sideways",
        page: "-5",
        perPage: "999999",
        status: "not_a_status",
        canonicalOnly: "false",
      }),
    );
    expect(f.sort).toBe("created_at");
    expect(f.dir).toBe("desc");
    expect(f.page).toBe(1);
    expect(f.perPage).toBe(MAX_PER_PAGE);
    expect(f.status).toBeNull();
    expect(f.canonicalOnly).toBe(false);
    // It still runs, and the table (and its rows) are untouched.
    const res = await fetchAgencyDirectory(pool, f);
    expect(res.rows.length).toBeGreaterThan(0);
    const after = await pool.query("select count(*)::int n from public.company");
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(
      (await pool.query("select count(*)::int n from public.company where id = $1", [co.companyId]))
        .rows[0].n,
    ).toBe(1);
  });

  it("treats % and _ in a search term as literals, not wildcards", async () => {
    const weird = await seed("wildcard");
    // A bare "%" must not match everything.
    const res = await fetchAgencyDirectory(
      pool,
      parseAgencyFilters(new URLSearchParams({ q: "%%%", perPage: "50" })),
    );
    expect(res.rows.map((r) => r.id)).not.toContain(weird.companyId);
    const hit = await fetchAgencyDirectory(
      pool,
      parseAgencyFilters(new URLSearchParams({ q: "P3exp wildcard", perPage: "50" })),
    );
    expect(hit.rows.map((r) => r.id)).toContain(weird.companyId);
  });

  it("rolls up evidence counts and source attribution per company", async () => {
    const co = await seed("evroll");
    await ingestObservation(
      pool,
      { companyId: co.companyId, sourceKey: "company-site", url: "https://acme.example/x", excerpt: "P3EXP one", actor: ACTOR },
      { predicate: "hiring", text: "P3EXP claim one", reliability: "B", credibility: 2 },
    );
    await ingestObservation(
      pool,
      { companyId: co.companyId, sourceKey: "agency-directory", url: "https://acme.example/y", excerpt: "P3EXP two", actor: ACTOR },
      { predicate: "growth", text: "P3EXP claim two", reliability: "C", credibility: 3 },
    );
    const res = await fetchAgencyDirectory(
      pool,
      parseAgencyFilters(new URLSearchParams({ q: co.companyId })),
    );
    const row = res.rows.find((r) => r.id === co.companyId);
    expect(row).toBeDefined();
    expect(row!.evidence_count).toBe(2);
    expect(row!.latest_source_key).not.toBeNull();
    expect(Date.parse(row!.latest_evidence_at!)).not.toBeNaN();

    // A company with no evidence reports zero, not a fabricated count.
    const bare = await seed("bare");
    const bareRes = await fetchAgencyDirectory(
      pool,
      parseAgencyFilters(new URLSearchParams({ q: bare.companyId })),
    );
    const bareRow = bareRes.rows.find((r) => r.id === bare.companyId)!;
    expect(bareRow.evidence_count).toBe(0);
    expect(bareRow.latest_evidence_at).toBeNull();
    expect(bareRow.latest_source_key).toBeNull();
  });
});

describe("export endpoint", () => {
  function req(query: string, authed = true): NextRequest {
    return new NextRequest(`${ORIGIN}/api/export?${query}`, {
      headers: {
        host: "127.0.0.1:3101",
        ...(authed ? { cookie: `gsid=${token}`, origin: ORIGIN } : {}),
      },
    });
  }

  it("refuses anonymous callers", async () => {
    const res = await exportGET(req("format=csv", false));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthorized" });
  });

  it("rejects an unknown format", async () => {
    const res = await exportGET(req("format=xlsx"));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "bad_format" });
  });

  it("returns a CSV attachment with stable headers and no secrets", async () => {
    await seed("csvexport");
    const res = await exportGET(req("format=csv"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="agencies-/);
    const body = await res.text();
    // NOTE: Response.text() decodes UTF-8 and therefore strips the BOM the
    // encoder emits. The BOM's presence is asserted directly on toCsv() above;
    // here we assert the decoded payload starts at the header row.
    expect(body.startsWith("company_id,")).toBe(true);
    const headerLine = body.split("\r\n")[0];
    expect(headerLine).toBe(AGENCY_EXPORT_COLUMNS.map((c) => c.key).join(","));
    // No operational secrets may ever appear in an export.
    expect(body).not.toMatch(/postgres:\/\/|5434|OPERATOR_API_TOKEN|SECRET|password/i);
  });

  it("exports exactly the filtered dataset the directory shows", async () => {
    const keep = await seed("parity-keep", { country: "Portugal" });
    await seed("parity-drop", { country: "Iceland" });
    const query = "format=json&country=Portugal";
    const res = await exportGET(req(query));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      row_count: number;
      filters: Record<string, unknown>;
      columns: { key: string; semantics: string }[];
      rows: Record<string, unknown>[];
    };
    expect(body.filters["country"]).toBe("Portugal");
    expect(body.row_count).toBe(body.rows.length);
    expect(body.rows.map((r) => r["company_id"])).toContain(keep.companyId);
    const dropped = await seed("parity-drop2", { country: "Iceland" });
    expect(body.rows.map((r) => r["company_id"])).not.toContain(dropped.companyId);
    // Column semantics travel with the payload.
    expect(body.columns.find((c) => c.key === "discovery_status")?.semantics).toMatch(/WORKFLOW/);

    // Same filter through the directory builder must yield the same ids.
    const filters = parseAgencyFilters(new URLSearchParams({ country: "Portugal" }));
    const dir = await fetchAgencyDirectory(pool, filters);
    expect(dir.rows.map((r) => r.id).sort()).toEqual(body.rows.map((r) => r["company_id"]).sort());
  });

  it("neutralizes an injected company name in the CSV body", async () => {
    // A name that a spreadsheet would otherwise execute on open.
    const evil = '=cmd|\' /c calc\'!A1';
    await createCompany(
      pool,
      { name: evil, domain: `p3exp-evil-${Date.now()}.example`, agencyType: "web_development", country: "Peru" },
      ACTOR,
    );
    const res = await exportGET(req("format=csv&country=Peru"));
    const body = await res.text();
    // The dangerous form is gone; the value survives, neutralized by a
    // leading apostrophe so a spreadsheet treats it as text.
    expect(body).not.toMatch(/^\s*=cmd/m);
    const dataLine = body.split("\r\n").find((l) => l.includes("p3exp-evil"))!;
    expect(dataLine).toContain(`'=cmd|' /c calc'!A1`);
  });

  it("reports truncation instead of silently returning a partial file", async () => {
    await seed("capped-a");
    await seed("capped-b");
    // Below the real ceiling: nothing is truncated and the flag says so.
    const full = await fetchAgencyRowsForExport(pool, parseAgencyFilters(new URLSearchParams()));
    expect(full.capped).toBe(false);
    expect(full.rows.length).toBe(2);

    // With a cap below the match count: truncation is explicit.
    const { capped, rows } = await fetchAgencyRowsForExport(
      pool,
      parseAgencyFilters(new URLSearchParams()),
      1,
    );
    expect(rows).toHaveLength(1);
    expect(capped).toBe(true);

    const res = await exportGET(req("format=json"));
    expect(res.headers.get("X-Export-Capped")).toBe("false");
    const body = (await res.json()) as { truncated: boolean; row_count: number };
    expect(body.truncated).toBe(false);
    expect(body.row_count).toBe(2);
  });

  it("handles an empty result set without failing", async () => {
    const res = await exportGET(req("format=json&country=Atlantis"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { row_count: number; rows: unknown[] };
    expect(body.row_count).toBe(0);
    expect(body.rows).toEqual([]);

    const csv = await exportGET(req("format=csv&country=Atlantis"));
    expect(csv.status).toBe(200);
    expect((await csv.text()).replace("\uFEFF", "").trim()).toBe(
      AGENCY_EXPORT_COLUMNS.map((c) => c.key).join(","),
    );
  });
});