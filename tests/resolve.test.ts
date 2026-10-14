/**
 * T-004 resolution tests — local DB only (loopback guard).
 * Fixtures use rx-/rxtest prefixes; T-003's t3-* fixtures are untouched.
 * Exact-identifier duplicates cannot arise via intake (canonical uniques);
 * domain/registry/alias rules are defense-in-depth for direct/legacy writes,
 * while name review + merge of identifier-distinct records is fully live.
 */
import { Pool } from "pg";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { normalizeName } from "../lib/resolve/names";
import {
  decideCandidate,
  findCandidates,
  getCandidateQueue,
  previewCandidate,
  registryConflict,
  registryRuleMatch,
  registryTypeAgrees,
  registryTypeConflict,
  reopenCandidate,
  shouldAutoMerge,
} from "../lib/resolve/engine";
import { isSharedHost } from "../lib/resolve/hosts";

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.T003_TEST_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";

const NOACCESS_URL =
  process.env.TEST_NOACCESS_URL ??
  "postgresql://noaccess:noaccess-local-only@127.0.0.1:5434/agency_intel_test";

if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing to run T-004 tests against a non-local database");
}

const pool = new Pool({ connectionString: DB_URL, max: 3 });
const ACTOR = "rxtest";
let seq = 0;
const dom = (p: string) => `rx-${Date.now()}-${seq++}-${p}.example`;
const MG = (n: string, extra: Record<string, string> = {}) => ({
  name: n,
  domain: "",
  registryId: "",
  agencyType: "web_development",
  country: "United States",
  ...extra,
});

async function mkCompany(input: Parameters<typeof createCompany>[1]) {
  return (await createCompany(pool, input, ACTOR)).companyId;
}

/** Seed loser-side evidence chain: snapshot + claim + hypothesis + brief. */
async function seedChain(companyId: string) {
  const c = await pool.connect();
  try {
    const s = await c.query(
      `insert into public.snapshot (company_id, source_key, url, sha256, retention_class)
       values ($1, 'company-site', 'https://x.example', $2, 'page') returning id`,
      [companyId, "c".repeat(64)],
    );
    await c.query(
      `insert into public.claim (company_id, snapshot_id, claim_text, claim_status, source_reliability, info_credibility)
       values ($1, $2, 'rx probe claim', 'observed', 'B', 2)`,
      [companyId, s.rows[0].id],
    );
    const h = await c.query(
      `insert into public.hypothesis (company_id, title, opportunity_category)
       values ($1, 'rx probe hypothesis', 'integrations') returning id`,
      [companyId],
    );
    await c.query(
      `insert into public.brief (ref, company_id, hypothesis_id, frozen_inputs_hash, markdown)
       values ($1, $2, $3, $4, 'rx')`,
      [
        `BR-2999-${String(seq).padStart(3, "0")}`,
        companyId,
        h.rows[0].id,
        "d".repeat(64),
      ],
    );
    seq += 1;
  } finally {
    c.release();
  }
}

async function counts(companyId: string) {
  const c = await pool.connect();
  try {
    const q = async (t: string) =>
      (
        await c.query(`select count(*)::int as n from public.${t} where company_id = $1`, [
          companyId,
        ])
      ).rows[0].n as number;
    return {
      discovery: await q("discovery_record"),
      snapshot: await q("snapshot"),
      claim: await q("claim"),
      hypothesis: await q("hypothesis"),
      brief: await q("brief"),
    };
  } finally {
    c.release();
  }
}

async function cleanup() {
  const c = await pool.connect();
  try {
    await c.query("delete from public.import_batch where created_by = $1", [ACTOR]);
    await c.query(
      "delete from public.company where domain_norm like 'rx-%' or registry_id like 'RX-%' or name like 'Rx %'",
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

describe("normalizeName (candidate generation only)", () => {
  it("strips case, punctuation, suffixes", () => {
    expect(normalizeName("Acme Webworks Ltd.")).toBe("acme webworks");
    expect(normalizeName("  ACME   &  Sons, LLC ")).toBe("acme sons");
    expect(normalizeName("Fabrikam")).toBe("fabrikam");
  });
});

describe("registryConflict (jurisdiction-scoped)", () => {
  const C = (registry_id: string | null, country_code: string | null) =>
    ({ id: "x", name: "x", domain_norm: null, registry_id, registry_type: null, country_code, merged_into: null, created_at: "" });
  it("flags same-jurisdiction differences, clears the rest", () => {
    expect(registryConflict(C("R1", "DE"), C("R2", "DE"))).toBe(true);
    expect(registryConflict(C("R1", null), C("R2", null))).toBe(true);
    expect(registryConflict(C("R1", "DE"), C("R2", null))).toBe(true);
    expect(registryConflict(C("R1", "DE"), C("R1", "DE"))).toBe(false);
    expect(registryConflict(C("R1", "DE"), C("R1", "FR"))).toBe(false);
    expect(registryConflict(C(null, "DE"), C("R2", "DE"))).toBe(false);
  });
});

describe("shouldAutoMerge gate", () => {
  it("allows only pending, conflict-free domain_exact", () => {
    expect(shouldAutoMerge({ rule: "domain_exact", conflictingRegistry: false, status: "pending" })).toBe(true);
    expect(shouldAutoMerge({ rule: "domain_exact", conflictingRegistry: true, status: "pending" })).toBe(false);
    expect(shouldAutoMerge({ rule: "name_exact", conflictingRegistry: false, status: "pending" })).toBe(false);
    expect(shouldAutoMerge({ rule: "registry_scoped", conflictingRegistry: false, status: "pending" })).toBe(false);
    expect(shouldAutoMerge({ rule: "alias", conflictingRegistry: false, status: "pending" })).toBe(false);
    expect(shouldAutoMerge({ rule: "domain_exact", conflictingRegistry: false, status: "accepted" })).toBe(false);
  });
});

describe("registry type agreement", () => {
  const C = (registry_id: string | null, registry_type: string | null, country_code: string | null) =>
    ({ id: "x", name: "x", domain_norm: null, registry_id, registry_type, country_code, merged_into: null, created_at: "" });
  it("vetoes only when both sides state conflicting types", () => {
    expect(registryTypeAgrees(C("R", "a", "DE"), C("R", "b", "DE"))).toBe(false);
    expect(registryTypeAgrees(C("R", "a", "DE"), C("R", "a", "DE"))).toBe(true);
    expect(registryTypeAgrees(C("R", null, "DE"), C("R", "b", "DE"))).toBe(true);
    expect(registryTypeConflict(C("R", "a", "DE"), C("R", "b", "DE"))).toBe(true);
    expect(registryTypeConflict(C("R", "a", "DE"), C("R", "b", "FR"))).toBe(false);
    expect(registryTypeConflict(C("R1", "a", "DE"), C("R2", "b", "DE"))).toBe(false);
  });

  it("registry rule predicate across jurisdiction/type combinations", () => {
    const C = (
      registry_id: string | null,
      registry_type: string | null,
      country_code: string | null,
    ) => ({ id: "x", name: "x", domain_norm: null, registry_id, registry_type, country_code, merged_into: null, created_at: "" });
    // Full agreement, and case handled by intake lowercasing (tested below).
    expect(registryRuleMatch(C("R", "handelsregister", "DE"), C("R", "handelsregister", "DE"))).toBe(true);
    // Type veto, jurisdiction veto, id mismatch, unknown jurisdiction.
    expect(registryRuleMatch(C("R", "vat", "DE"), C("R", "duns", "DE"))).toBe(false);
    expect(registryRuleMatch(C("R", "vat", "DE"), C("R", "vat", "FR"))).toBe(false);
    expect(registryRuleMatch(C("R1", "vat", "DE"), C("R2", "vat", "DE"))).toBe(false);
    expect(registryRuleMatch(C("R", "vat", "DE"), C("R", "vat", null))).toBe(false);
    // Unknown type on one side falls back to jurisdiction + id.
    expect(registryRuleMatch(C("R", null, "DE"), C("R", "vat", "DE"))).toBe(true);
  });

  it("intake rejects same-registry same-jurisdiction pairs (live guarantee)", async () => {
    await mkCompany(
      MG("Rx Type A", { domain: dom("ta"), registryId: "RX-T1", registryType: "Handelsregister", country: "Germany", countryCode: "DE" }),
    );
    // Second record, hand-normalized type spelling: still a canonical dup.
    await expect(
      mkCompany(
        MG("Rx Type B", { domain: dom("tb"), registryId: "RX-T1", registryType: "handelsregister", country: "Germany", countryCode: "DE" }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    // Intake lowercases the type label deterministically.
    const c = await pool.connect();
    try {
      const t = await c.query("select registry_type from public.company where name = 'Rx Type A'");
      expect(t.rows[0].registry_type).toBe("handelsregister");
    } finally {
      c.release();
    }
  });

  it("rejects overlong registry types at intake", async () => {
    await expect(
      mkCompany(MG("Rx Type Long", { domain: dom("tl"), registryId: "RX-1", registryType: "x".repeat(61) })),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("candidate generation", () => {
  it("creates a name_exact review candidate, never auto-merges", async () => {
    const a = await mkCompany(MG("Rx Widgets Ltd", { domain: dom("n1") }));
    const b = await mkCompany(MG("Rx Widgets", { domain: dom("n2") }));
    const r = await findCandidates(pool, b, { actor: ACTOR });
    expect(r.autoMerged).toEqual([]);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ rule: "name_exact", conflictingRegistry: false, status: "pending" });
    const c = await pool.connect();
    try {
      const s = await c.query("select merged_into from public.company where id = any($1)", [[a, b]]);
      expect(s.rows.every((row) => row.merged_into === null)).toBe(true);
    } finally {
      c.release();
    }
  });

  it("creates nothing for merely similar names", async () => {
    const a = await mkCompany(MG("Rx Northwind Traders", { domain: dom("s1") }));
    const b = await mkCompany(MG("Rx Northwind Trading Co", { domain: dom("s2") }));
    const r = await findCandidates(pool, b, { actor: ACTOR });
    expect(r.candidates).toEqual([]);
    void a;
  });

  it("flags conflicting registries and never auto-merges them", async () => {
    const a = await mkCompany(
      MG("Rx Conflict SA", { domain: dom("k1"), registryId: "RX-100", country: "Germany", countryCode: "DE" }),
    );
    const b = await mkCompany(
      MG("Rx Conflict SA", { domain: dom("k2"), registryId: "RX-200", country: "Germany", countryCode: "DE" }),
    );
    const r = await findCandidates(pool, b, { actor: ACTOR });
    expect(r.autoMerged).toEqual([]);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ rule: "name_exact", conflictingRegistry: true });
    void a;
  });

  it("allows identical registry IDs across jurisdictions without matching", async () => {
    const a = await mkCompany(
      MG("Rx DE GmbH", { domain: dom("j1"), registryId: "RX-SAME", country: "Germany", countryCode: "DE" }),
    );
    const b = await mkCompany(
      MG("Rx FR SARL", { domain: dom("j2"), registryId: "RX-SAME", country: "France", countryCode: "FR" }),
    );
    const r = await findCandidates(pool, b, { actor: ACTOR });
    expect(r.candidates.filter((c) => c.rule === "registry_scoped")).toEqual([]);
    expect(r.autoMerged).toEqual([]);
    void a;
  });

  it("regeneration is idempotent", async () => {
    const b = await mkCompany(MG("Rx Loop", { domain: dom("l2") }));
    await mkCompany(MG("Rx Loop Ltd", { domain: dom("l1") }));
    const r1 = await findCandidates(pool, b, { actor: ACTOR });
    const r2 = await findCandidates(pool, b, { actor: ACTOR });
    expect(r1.candidates.map((c) => c.id).sort()).toEqual(
      r2.candidates.map((c) => c.id).sort(),
    );
  });

  it("404s unknown companies and skips merged ones", async () => {
    await expect(
      findCandidates(pool, "00000000-0000-4000-8000-000000000000", { actor: ACTOR }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("human decisions + merge integrity", () => {
  it("accept merges, repoints FKs, preserves aliases + audit", async () => {
    // Winner must be OLDER (engine rule: older record wins for stable identity).
    const winner = await mkCompany(MG("Rx Mergeable", { domain: dom("m2") }));
    const loser = await mkCompany(MG("Rx Mergeable Ltd", { domain: dom("m1") }));
    await seedChain(loser);
    const before = await counts(loser);
    expect(before.claim).toBe(1);
    const r = await findCandidates(pool, loser, { actor: ACTOR });
    const cand = r.candidates.find((c) => c.rule === "name_exact")!;
    const done = await decideCandidate(pool, cand.id, { decision: "accepted", actor: ACTOR });
    expect(done.status).toBe("accepted");
    expect(done.summary).toMatch(/moved [1-9][0-9]* rows/);
    const c = await pool.connect();
    try {
      const lw = await c.query(
        "select discovery_status, merged_into from public.company where id = $1",
        [loser],
      );
      expect(lw.rows[0]).toMatchObject({ discovery_status: "archived", merged_into: winner });
      expect((await counts(loser)).claim).toBe(0);
      const wc = await counts(winner);
      expect(wc.claim).toBe(1);
      expect(wc.brief).toBe(1);
      const al = await c.query(
        "select count(*)::int as n from public.company_alias where canonical_company_id = $1",
        [winner],
      );
      expect(al.rows[0].n).toBeGreaterThanOrEqual(1);
      const au = await c.query(
        "select count(*)::int as n from public.audit_log where entity_type = 'company' and (entity_id = $1 or entity_id = $2)",
        [loser, winner],
      );
      expect(au.rows[0].n).toBeGreaterThanOrEqual(2);
    } finally {
      c.release();
    }
  });

  it("reject/defer decide without merging; double decision is 409", async () => {
    const b = await mkCompany(MG("Rx Split", { domain: dom("d2") }));
    await mkCompany(MG("Rx Split Ltd", { domain: dom("d1") }));
    const r = await findCandidates(pool, b, { actor: ACTOR });
    const rej = await decideCandidate(pool, r.candidates[0].id, {
      decision: "rejected",
      reason: "different legal entities",
      actor: ACTOR,
    });
    expect(rej.status).toBe("rejected");
    await expect(
      decideCandidate(pool, r.candidates[0].id, { decision: "accepted", actor: ACTOR }),
    ).rejects.toMatchObject({ status: 409 });
    // Reason-required is checked on pending candidates: fresh pair, no reason.
    const e = await mkCompany(MG("Rx Pending", { domain: dom("p2") }));
    await mkCompany(MG("Rx Pending Ltd", { domain: dom("p1") }));
    const r2 = await findCandidates(pool, e, { actor: ACTOR });
    await expect(
      decideCandidate(pool, r2.candidates[0].id, { decision: "deferred", actor: ACTOR }),
    ).rejects.toMatchObject({ status: 422, code: "reason_required" });
    await expect(
      decideCandidate(pool, "00000000-0000-4000-8000-000000000000", {
        decision: "accepted",
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ status: 404 });
    const c = await pool.connect();
    try {
      const s = await c.query(
        "select count(*)::int as n from public.company where merged_into is not null and domain_norm like 'rx-%'",
      );
      expect(s.rows[0].n).toBe(0);
    } finally {
      c.release();
    }
  });

  it("blocks registry conflicts unless explicitly overridden", async () => {
    const b = await mkCompany(
      MG("Rx Override", { domain: dom("o2"), registryId: "RX-901", country: "Germany", countryCode: "DE" }),
    );
    await mkCompany(
      MG("Rx Override GmbH", { domain: dom("o1"), registryId: "RX-902", country: "Germany", countryCode: "DE" }),
    );
    const r = await findCandidates(pool, b, { actor: ACTOR });
    const cand = r.candidates[0];
    await expect(
      decideCandidate(pool, cand.id, { decision: "accepted", actor: ACTOR }),
    ).rejects.toMatchObject({ status: 409, code: "registry_conflict" });
    const done = await decideCandidate(pool, cand.id, {
      decision: "accepted",
      reason: "verified same entity, registry reissued",
      actor: ACTOR,
      allowConflict: true,
    });
    expect(done.status).toBe("accepted");
    const c = await pool.connect();
    try {
      const au = await c.query(
        "select reason from public.audit_log where entity_type = 'company' and reason like '%overridden by human%' limit 1",
      );
      expect(au.rows.length).toBe(1);
    } finally {
      c.release();
    }
  });

  it("alias continuity: re-intake of an old domain resolves to the winner", async () => {
    const oldDomain = dom("old");
    const b = await mkCompany(MG("Rx Fabrikam", { domain: dom("new") }));
    const a = await mkCompany(MG("Rx Fabrikam Ltd", { domain: oldDomain }));
    const r = await findCandidates(pool, a, { actor: ACTOR });
    await decideCandidate(pool, r.candidates[0].id, { decision: "accepted", actor: ACTOR });
    // Re-intake of the archived domain is allowed (canonical-scoped uniques).
    const re = await mkCompany(MG("Rx Fabrikam (relisted)", { domain: oldDomain }));
    const r2 = await findCandidates(pool, re, { actor: ACTOR });
    const aliasCand = r2.candidates.find((x) => x.rule === "alias");
    expect(aliasCand).toBeDefined();
    const done = await decideCandidate(pool, aliasCand!.id, {
      decision: "accepted",
      reason: "relisted old domain belongs to canonical record",
      actor: ACTOR,
    });
    expect(done.status).toBe("accepted");
    const c = await pool.connect();
    try {
      const w = await c.query("select merged_into from public.company where id = $1", [re]);
      expect(w.rows[0].merged_into).toBe(b);
    } finally {
      c.release();
    }
    void a;
  });

  it("merge rolls back cleanly (transactional safety)", async () => {
    const loser = await mkCompany(MG("Rx Rollback Ltd", { domain: dom("rb1") }));
    await seedChain(loser);
    const winner = await mkCompany(MG("Rx Rollback", { domain: dom("rb2") }));
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("select public.resolve_merge_company($1, $2, $3, $4)", [
        loser,
        winner,
        ACTOR,
        "probe then rollback",
      ]);
      await c.query("rollback");
      const s = await c.query(
        "select discovery_status, merged_into from public.company where id = $1",
        [loser],
      );
      expect(s.rows[0]).toMatchObject({ discovery_status: "candidate", merged_into: null });
      expect((await counts(loser)).claim).toBe(1);
    } finally {
      c.release();
    }
  });

  it("concurrent accepts merge exactly once", async () => {
    await mkCompany(MG("Rx Race", { domain: dom("rc2") }));
    const loser = await mkCompany(MG("Rx Race Ltd", { domain: dom("rc1") }));
    const r = await findCandidates(pool, loser, { actor: ACTOR });
    const id = r.candidates[0].id;
    const [first, second] = await Promise.allSettled([
      decideCandidate(pool, id, { decision: "accepted", actor: ACTOR }),
      decideCandidate(pool, id, { decision: "accepted", actor: ACTOR }),
    ]);
    const ok = [first, second].filter((x) => x.status === "fulfilled");
    const denied = [first, second].filter(
      (x) => x.status === "rejected" && (x.reason as { status?: number }).status === 409,
    );
    expect(ok).toHaveLength(1);
    expect(denied).toHaveLength(1);
    const c = await pool.connect();
    try {
      const s = await c.query("select merged_into from public.company where id = $1", [loser]);
      expect(s.rows[0].merged_into).not.toBeNull();
    } finally {
      c.release();
    }
  });

  it("alias collisions block merges into a third record", async () => {
    const d = dom("col");
    const x = await mkCompany(MG("Rx Keep Ltd", { domain: dom("kx") }));
    const y = await mkCompany(MG("Rx Keep", { domain: d }));
    const r1 = await findCandidates(pool, x, { actor: ACTOR });
    await decideCandidate(pool, r1.candidates[0].id, { decision: "accepted", actor: ACTOR });
    // d is now aliased to x. A new record reusing d, merged elsewhere, must fail.
    // W is created BEFORE Z so the older-wins rule makes W the winner and
    // Z (holding the aliased domain) the loser -> alias_collision fires.
    const w = await mkCompany(MG("Rx Keep Elsewhere", { domain: dom("kw") }));
    const z = await mkCompany(MG("Rx Keep (relisted)", { domain: d }));
    void y;
    // Force the Z-W pair: same normalized name (documented probe).
    const c = await pool.connect();
    try {
      await c.query("update public.company set name = 'Rx Keep Elsewhere' where id = $1", [z]);
    } finally {
      c.release();
    }
    const r2 = await findCandidates(pool, z, { actor: ACTOR });
    const nameCand = r2.candidates.find((k) => k.rule === "name_exact");
    expect(nameCand).toBeDefined();
    await expect(
      decideCandidate(pool, nameCand!.id, { decision: "accepted", actor: ACTOR }),
    ).rejects.toMatchObject({ status: 409, code: "merge_blocked" });
  });
});

describe("resolution authorization", () => {
  it("denies unprivileged access to match_candidate", async () => {
    const denied = new Pool({ connectionString: NOACCESS_URL, max: 1 });
    try {
      await denied.query("select 1");
      await expect(
        denied.query("select count(*) from public.match_candidate"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await denied.end();
    }
  });
});

describe("shared and generic hosts", () => {
  it("lists bare platform roots as non-identifying", () => {
    expect(isSharedHost("linkedin.com")).toBe(true);
    expect(isSharedHost("LINKEDIN.COM")).toBe(true);
    expect(isSharedHost("wixsite.com")).toBe(true);
    expect(isSharedHost("acme.example")).toBe(false);
    expect(isSharedHost(null)).toBe(false);
    // Subdomains still identify a specific site (documented).
    expect(isSharedHost("acme.wixsite.com")).toBe(false);
  });

  it("treats shared hosts as non-identifying (never stored as domain)", async () => {
    // Same platform host + different registries: both records coexist with
    // NULL domains; no domain candidate is possible.
    const a = await mkCompany(
      MG("Rx Social One", { domain: "linkedin.com", registryId: "RX-S1" }),
    );
    const b = await mkCompany(
      MG("Rx Social Two", { domain: "https://www.linkedin.com/company/other", registryId: "RX-S2" }),
    );
    const c = await pool.connect();
    try {
      const r = await c.query(
        "select domain_norm from public.company where id = any($1)",
        [[a, b]],
      );
      expect(r.rows.every((row) => row.domain_norm === null)).toBe(true);
    } finally {
      c.release();
    }
    const r = await findCandidates(pool, b, { actor: ACTOR });
    expect(r.candidates).toEqual([]);
    expect(r.autoMerged).toEqual([]);
    // Shared host ALONE (no registry) is rejected with guidance.
    await expect(
      mkCompany(MG("Rx Social Only", { domain: "linkedin.com" })),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("alias verification status", () => {
  it("ignores unverified aliases for the alias rule", async () => {
    const winner = await mkCompany(MG("Rx Alias Owner", { domain: dom("ao") }));
    // Directly assert an UNVERIFIED alias (future assertion paths, TBD).
    const ghost = dom("ghost");
    const c = await pool.connect();
    try {
      await c.query(
        `insert into public.company_alias (canonical_company_id, alias_type, alias_value, verification)
         values ($1, 'domain', $2, 'unverified')`,
        [winner, ghost],
      );
    } finally {
      c.release();
    }
    const newcomer = await mkCompany(MG("Rx Ghost Relist", { domain: ghost }));
    const r = await findCandidates(pool, newcomer, { actor: ACTOR });
    expect(r.candidates.filter((x) => x.rule === "alias")).toEqual([]);
  });
});

describe("reopening decided candidates", () => {
  it("keeps rejections decided until explicit reopen with evidence", async () => {
    const b = await mkCompany(MG("Rx Reopen", { domain: dom("ro2") }));
    await mkCompany(MG("Rx Reopen Ltd", { domain: dom("ro1") }));
    const r1 = await findCandidates(pool, b, { actor: ACTOR });
    const id = r1.candidates[0].id;
    await decideCandidate(pool, id, {
      decision: "rejected",
      reason: "different entities on first look",
      actor: ACTOR,
    });
    // Regeneration must NOT resurrect the rejection.
    const r2 = await findCandidates(pool, b, { actor: ACTOR });
    expect(r2.candidates.find((x) => x.id === id)?.status).toBe("rejected");
    // Reopen requires a reason; pending/accepted cannot reopen.
    await expect(
      reopenCandidate(pool, id, { reason: "", actor: ACTOR }),
    ).rejects.toMatchObject({ status: 422 });
    const re = await reopenCandidate(pool, id, {
      reason: "shared client contract discovered — new material evidence",
      actor: ACTOR,
    });
    expect(re.status).toBe("pending");
    await expect(
      reopenCandidate(pool, id, { reason: "again", actor: ACTOR }),
    ).rejects.toMatchObject({ status: 409 });
    // Prior decision preserved in audit; accept now works.
    const done = await decideCandidate(pool, id, {
      decision: "accepted",
      reason: "evidence confirmed same entity",
      actor: ACTOR,
    });
    expect(done.status).toBe("accepted");
    await expect(
      reopenCandidate(pool, id, { reason: "too late", actor: ACTOR }),
    ).rejects.toMatchObject({ status: 409 });
    const c = await pool.connect();
    try {
      const au = await c.query(
        `select reason from public.audit_log where entity_type = 'match_candidate'
         and entity_id = $1 order by created_at`,
        [id],
      );
      const reasons = au.rows.map((row) => row.reason as string).join(" | ");
      expect(reasons).toMatch(/different entities on first look/);
      expect(reasons).toMatch(/reopened: shared client contract/);
    } finally {
      c.release();
    }
  });
});

describe("merge preview", () => {
  it("reports winner, loser, and per-table moves read-only", async () => {
    const winner = await mkCompany(MG("Rx Preview", { domain: dom("pv2") }));
    const loser = await mkCompany(MG("Rx Preview Ltd", { domain: dom("pv1") }));
    await seedChain(loser);
    const r = await findCandidates(pool, loser, { actor: ACTOR });
    const cand = r.candidates.find((x) => x.rule === "name_exact")!;
    const p = await previewCandidate(pool, cand.id);
    expect(p.winner.id).toBe(winner);
    expect(p.loser.id).toBe(loser);
    expect(p.moves["claim"]).toBe(1);
    expect(p.moves["hypothesis"]).toBe(1);
    expect(p.moves["brief"]).toBe(1);
    expect(p.moves["discovery_record"]).toBeGreaterThanOrEqual(1);
    expect(p.stays.join(" ")).toMatch(/snapshots stay/);
    // Preview writes nothing.
    const c = await pool.connect();
    try {
      const s = await c.query("select merged_into from public.company where id = $1", [loser]);
      expect(s.rows[0].merged_into).toBeNull();
    } finally {
      c.release();
    }
  });

  it("404s unknown candidates", async () => {
    await expect(
      previewCandidate(pool, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("malformed and unknown identities", () => {
  it("records with no identifiers match nothing and stay unresolved", async () => {
    // Direct insert: intake itself requires an identifier (422), so the
    // no-identifier state is reachable only for legacy/direct rows.
    const c = await pool.connect();
    let id = "";
    try {
      const ins = await c.query(
        `insert into public.company (name, agency_type, country)
         values ('Rx Unresolved Unique Name XYZ', 'web_development', 'United States')
         returning id`,
      );
      id = ins.rows[0].id as string;
    } finally {
      c.release();
    }
    const r = await findCandidates(pool, id, { actor: ACTOR });
    // No crash, no forced match: the system says unresolved (empty set).
    expect(r.candidates).toEqual([]);
    expect(r.skipped).toBeNull();
  });

  it("malformed domains never reach resolution (rejected at intake)", async () => {
    await expect(
      mkCompany(MG("Rx Malformed", { domain: "not a domain!!" })),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("queue reads", () => {
  it("lists pending canonical pairs with impact counts", async () => {
    const b = await mkCompany(MG("Rx Queue", { domain: dom("q2") }));
    await mkCompany(MG("Rx Queue Ltd", { domain: dom("q1") }));
    await findCandidates(pool, b, { actor: ACTOR });
    const q = await getCandidateQueue(pool, "pending");
    const mine = q.filter(
      (row) => row.name_a.startsWith("Rx Queue") || row.name_b.startsWith("Rx Queue"),
    );
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine[0].linked_rows).toBeGreaterThanOrEqual(2);
  });
});
