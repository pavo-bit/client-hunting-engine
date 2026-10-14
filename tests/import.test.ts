/**
 * T-003 integration tests — run against the LOCAL Supabase stack only.
 * Never points at a remote DB: default URL is 127.0.0.1, override only via
 * T003_TEST_DB_URL (which the suite refuses if it is not loopback).
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  confirmImport,
  createCompany,
  getBatchPreview,
  previewImport,
} from "../lib/intake/import";

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.T003_TEST_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";

const NOACCESS_URL =
  process.env.TEST_NOACCESS_URL ??
  "postgresql://noaccess:noaccess-local-only@127.0.0.1:5434/agency_intel_test";

if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing to run T-003 tests against a non-local database");
}

const pool = new Pool({ connectionString: DB_URL, max: 3 });
const ACTOR = "t3test";
let seq = 0;
const uniq = (p: string) => `t3-${Date.now()}-${seq++}-${p}.example`;

const HEADER =
  "name,domain,registry_id,agency_type,country,country_code,region,website_url";
const mkrow = (
  name: string,
  domain: string,
  extra: Record<string, string> = {},
) =>
  [
    name,
    domain,
    extra.registry_id ?? "",
    extra.agency_type ?? "web_development",
    extra.country ?? "United States",
    extra.country_code ?? "US",
    extra.region ?? "",
    extra.website_url ?? "",
  ].join(",");
const mkcsv = (rows: string[]) => HEADER + "\n" + rows.join("\n") + "\n";

async function cleanup() {
  const c = await pool.connect();
  try {
    await c.query("delete from public.import_batch where created_by = $1", [ACTOR]);
    await c.query(
      "delete from public.company where domain_norm like 't3-%' or registry_id like 'T3-%'",
    );
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await cleanup();
});
afterEach(async () => {
  await cleanup();
});

describe("manual creation", () => {
  it("creates a company + discovery record + audit", async () => {
    const d = uniq("manual");
    const { companyId } = await createCompany(
      pool,
      { name: "Manual Co", domain: `https://WWW.${d}/`, agencyType: "mobile_app", country: "Singapore" },
      ACTOR,
    );
    const c = await pool.connect();
    try {
      const r = await c.query(
        "select domain_norm, discovery_status from public.company where id = $1",
        [companyId],
      );
      expect(r.rows[0]).toMatchObject({ domain_norm: d, discovery_status: "candidate" });
      const dr = await c.query(
        "select collection_method from public.discovery_record where company_id = $1",
        [companyId],
      );
      expect(dr.rows[0].collection_method).toBe("manual");
      const au = await c.query(
        "select actor from public.audit_log where entity_type='company' and entity_id=$1",
        [companyId],
      );
      expect(au.rows[0].actor).toBe(ACTOR);
    } finally {
      c.release();
    }
  });

  it("rejects missing/malformed fields (422) without writing", async () => {
    await expect(
      createCompany(pool, { name: "", domain: "", agencyType: "web_development", country: "" }, ACTOR),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      createCompany(
        pool,
        { name: "X", domain: "nodot", agencyType: "nope", country: "US" },
        ACTOR,
      ),
    ).rejects.toMatchObject({ status: 422 });
    const c = await pool.connect();
    try {
      const r = await c.query(
        "select count(*)::int as n from public.company where name = 'X'",
      );
      expect(r.rows[0].n).toBe(0);
    } finally {
      c.release();
    }
  });

  it("detects duplicates incl. differently-cased/URL forms (409)", async () => {
    const d = uniq("dup");
    await createCompany(
      pool,
      { name: "Dup", domain: d, agencyType: "ecommerce", country: "Germany" },
      ACTOR,
    );
    await expect(
      createCompany(
        pool,
        { name: "Dup2", domain: `HTTPS://WWW.${d.toUpperCase()}/path?q=1`, agencyType: "ecommerce", country: "Germany" },
        ACTOR,
      ),
    ).rejects.toMatchObject({ status: 409, code: "duplicate_company" });
  });
});

describe("csv preview + confirm", () => {
  it("imports a valid file end to end", async () => {
    const csv = mkcsv([mkrow("A One", uniq("a1")), mkrow("A Two", uniq("a2"))]);
    const preview = await previewImport(pool, { filename: "ok.csv", csvText: csv, actor: ACTOR });
    expect(preview.summary).toMatchObject({ total: 2, valid: 2, invalid: 0 });
    const done = await confirmImport(pool, preview.batchId, ACTOR);
    expect(done.alreadyCommitted).toBe(false);
    expect(done.summary).toMatchObject({ imported: 2, skipped: 0 });
    const c = await pool.connect();
    try {
      const r = await c.query(
        "select count(*)::int as n from public.company where domain_norm like 't3-%'",
      );
      expect(r.rows[0].n).toBe(2);
    } finally {
      c.release();
    }
  });

  it("reports invalid rows with numbers and imports the rest (partial success)", async () => {
    const csv = mkcsv([
      mkrow("Good", uniq("good")),
      mkrow("", uniq("noname")),
      ["Bad Type", uniq("badtype"), "", "crypto", "US", "US", "", ""].join(","),
      mkrow("Bad Domain", "nodot"),
    ]);
    const preview = await previewImport(pool, { filename: "mixed.csv", csvText: csv, actor: ACTOR });
    expect(preview.summary).toMatchObject({ total: 4, valid: 1, invalid: 3 });
    expect(preview.rows.filter((r) => r.status === "invalid").map((r) => r.rowNumber)).toEqual([3, 4, 5]);
    const done = await confirmImport(pool, preview.batchId, ACTOR);
    expect(done.summary).toMatchObject({ imported: 1, invalid: 3 });
  });

  it("flags in-file duplicates and imports the first occurrence only", async () => {
    const d = uniq("infile");
    const csv = mkcsv([mkrow("First", d), mkrow("Second", d.toUpperCase())]);
    const preview = await previewImport(pool, { filename: "dup.csv", csvText: csv, actor: ACTOR });
    expect(preview.summary).toMatchObject({ valid: 1, duplicateInFile: 1 });
    const done = await confirmImport(pool, preview.batchId, ACTOR);
    expect(done.summary.imported).toBe(1);
  });

  it("marks conflicts with existing records and never imports them", async () => {
    const d = uniq("exists");
    await createCompany(pool, { name: "Existing", domain: d, agencyType: "web_development", country: "US" }, ACTOR);
    const csv = mkcsv([mkrow("Clash", d), mkrow("Fresh", uniq("fresh"))]);
    const preview = await previewImport(pool, { filename: "clash.csv", csvText: csv, actor: ACTOR });
    expect(preview.summary).toMatchObject({ conflictExisting: 1, valid: 1 });
    const done = await confirmImport(pool, preview.batchId, ACTOR);
    expect(done.summary).toMatchObject({ imported: 1, conflictExisting: 1 });
  });

  it("marks a row conflicting between preview and confirm as unimported", async () => {
    const d = uniq("race");
    const csv = mkcsv([mkrow("Racer", d), mkrow("Other", uniq("other"))]);
    const preview = await previewImport(pool, { filename: "race.csv", csvText: csv, actor: ACTOR });
    expect(preview.summary.valid).toBe(2);
    // Rival write lands after preview, before confirm.
    await createCompany(pool, { name: "Rival", domain: d, agencyType: "web_development", country: "US" }, ACTOR);
    const done = await confirmImport(pool, preview.batchId, ACTOR);
    expect(done.summary.imported).toBe(1);
    expect(done.summary.conflictExisting + done.summary.skipped).toBe(1);
  });

  it("confirm is idempotent (no double import)", async () => {
    const csv = mkcsv([mkrow("Once", uniq("once"))]);
    const preview = await previewImport(pool, { filename: "once.csv", csvText: csv, actor: ACTOR });
    const first = await confirmImport(pool, preview.batchId, ACTOR);
    const second = await confirmImport(pool, preview.batchId, ACTOR);
    expect(first.summary.imported).toBe(1);
    expect(second.alreadyCommitted).toBe(true);
    expect(second.summary.imported).toBe(1);
    const c = await pool.connect();
    try {
      const r = await c.query(
        "select count(*)::int as n from public.company where domain_norm like 't3-%'",
      );
      expect(r.rows[0].n).toBe(1);
    } finally {
      c.release();
    }
  });

  it("concurrent confirms of one batch commit exactly once", async () => {
    const csv = mkcsv([mkrow("C1", uniq("c1")), mkrow("C2", uniq("c2"))]);
    const preview = await previewImport(pool, { filename: "conc.csv", csvText: csv, actor: ACTOR });
    const [a, b] = await Promise.all([
      confirmImport(pool, preview.batchId, ACTOR),
      confirmImport(pool, preview.batchId, ACTOR),
    ]);
    // Exactly one confirm does the work; the other replays the stored
    // summary (which also reports imported=2 — hence no summation here).
    expect([a.alreadyCommitted, b.alreadyCommitted].sort()).toEqual([false, true]);
    const c = await pool.connect();
    try {
      const r = await c.query(
        "select count(*)::int as n from public.company where domain_norm like 't3-%'",
      );
      expect(r.rows[0].n).toBe(2); // no duplicate companies
    } finally {
      c.release();
    }
  });

  it("concurrent batches racing the same domain import it once, skip once", async () => {
    const d = uniq("xr");
    const mk = (n: string) => previewImport(pool, { filename: `${n}.csv`, csvText: mkcsv([mkrow(n, d)]), actor: ACTOR });
    const [p1, p2] = await Promise.all([mk("X1"), mk("X2")]);
    const [r1, r2] = await Promise.all([
      confirmImport(pool, p1.batchId, ACTOR),
      confirmImport(pool, p2.batchId, ACTOR),
    ]);
    const imported = r1.summary.imported + r2.summary.imported;
    const notImported =
      r1.summary.skipped + r1.summary.conflictExisting + r2.summary.skipped + r2.summary.conflictExisting;
    expect(imported).toBe(1);
    expect(notImported).toBe(1);
  });

  it("all-invalid batch commits nothing but records the outcome", async () => {
    const csv = mkcsv([mkrow("", uniq("x")), mkrow("Bad", "nodot")]);
    const preview = await previewImport(pool, { filename: "allbad.csv", csvText: csv, actor: ACTOR });
    const done = await confirmImport(pool, preview.batchId, ACTOR);
    expect(done.summary).toMatchObject({ imported: 0, invalid: 2 });
    const full = await getBatchPreview(pool, preview.batchId);
    expect(full.status).toBe("committed");
  });

  it("404s on unknown batch", async () => {
    await expect(
      confirmImport(pool, "00000000-0000-4000-8000-000000000000", ACTOR),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("flags formula-risk cells and stores them verbatim", async () => {
    const csv = mkcsv([mkrow("=cmd(1)+2", uniq("f"))]);
    const preview = await previewImport(pool, { filename: "formula.csv", csvText: csv, actor: ACTOR });
    expect(preview.rows[0].formulaRisk).toBe(true);
    const done = await confirmImport(pool, preview.batchId, ACTOR);
    expect(done.summary.imported).toBe(1);
    const c = await pool.connect();
    try {
      const r = await c.query(
        "select name from public.company where domain_norm like 't3-%'",
      );
      expect(r.rows[0].name).toBe("=cmd(1)+2");
    } finally {
      c.release();
    }
  });
});

describe("file-level faults", () => {
  it("rejects empty, malformed, and header faults", async () => {
    await expect(
      previewImport(pool, { filename: "e.csv", csvText: "", actor: ACTOR }),
    ).rejects.toMatchObject({ status: 422, code: "empty_file" });
    await expect(
      previewImport(pool, { filename: "h.csv", csvText: HEADER + "\n", actor: ACTOR }),
    ).rejects.toMatchObject({ status: 422, code: "empty_file" });
    await expect(
      previewImport(pool, { filename: "m.csv", csvText: HEADER + '\n"oops', actor: ACTOR }),
    ).rejects.toMatchObject({ status: 422, code: "malformed_csv" });
    await expect(
      previewImport(pool, { filename: "c.csv", csvText: "name,domain\nA,a.example\n", actor: ACTOR }),
    ).rejects.toMatchObject({ status: 422, code: "missing_columns" });
    await expect(
      previewImport(pool, { filename: "x.csv", csvText: HEADER + ",linkedin\n" + mkrow("A", uniq("xa")) + ",z\n", actor: ACTOR }),
    ).rejects.toMatchObject({ status: 422, code: "unexpected_columns" });
  });

  it("accepts exactly 5000 rows and rejects 5001", async () => {
    const lines = [HEADER];
    for (let i = 0; i < 5000; i++) lines.push(mkrow(`Bulk ${i}`, uniq(`b${i}`)));
    const ok = await previewImport(
      pool,
      { filename: "bulk.csv", csvText: lines.join("\n") + "\n", actor: ACTOR },
    );
    expect(ok.summary).toMatchObject({ total: 5000, valid: 5000 });
    lines.push(mkrow("One Too Many", uniq("bX")));
    await expect(
      previewImport(pool, { filename: "over.csv", csvText: lines.join("\n") + "\n", actor: ACTOR }),
    ).rejects.toMatchObject({ status: 413, code: "row_limit_exceeded" });
  }, 120000);
});

describe("authorization", () => {
  it("denies unprivileged access to staging tables", async () => {
    const denied = new Pool({ connectionString: NOACCESS_URL, max: 1 });
    try {
      // CONNECT works (proves denial happens at table/RLS level, not login).
      await denied.query("select 1");
      await expect(
        denied.query("select count(*) from public.import_batch"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        denied.query(
          "insert into public.import_batch (filename, file_sha256, total_rows, created_by) values ('x', $1, 0, 'x')",
          ["a".repeat(64)],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await denied.end();
    }
  });
});

describe("no outreach-delivery path", () => {
  it("introduces no send/delivery code in app, lib, or components", () => {
    const roots = ["app", "lib", "components"];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(p)) {
          const s = readFileSync(p, "utf8");
          const m = s.match(
            /nodemailer|sendgrid|resend|mailgun|postmark|twilio|smtp|whatsapp|telegram-bot|discord\.js|contact-form-submit|auto-?send/i,
          );
          if (m) hits.push(`${p}: ${m[0]}`);
        }
      }
    };
    for (const r of roots) walk(r);
    expect(hits).toEqual([]);
  });
});
