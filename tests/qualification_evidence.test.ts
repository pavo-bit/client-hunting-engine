/**
 * Part 2 §5: evidence governance.
 *
 * Proven against stored rows in the test DB: deterministic normalization,
 * untrusted-URL refusal, duplicate collapse (same source, same announcement),
 * unapproved-source exclusion, expired/suppressed exclusion, contradiction
 * representation, entity-ambiguity override, and negative findings that refuse
 * incomplete searches. Plus a structural assertion that this module performs
 * no network I/O at all (Phase 2 consumes stored evidence; it does not fetch).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildEvidenceBundle,
  bundleHashOf,
  normalizeClaimText,
  recordNegativeFinding,
  safeSourceUrl,
} from "../lib/qualification/evidence";
import { ensureCase } from "../lib/qualification/cases";
import { readQualificationRow } from "../lib/qualification/view";
import { ACTOR, cleanupFixtures, registerFixtureSet, seedCompanyWithClaims } from "./qualification_fixtures";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 4 });

beforeAll(async () => {
  await cleanupFixtures(pool);
  await registerFixtureSet(pool, "ev");
});
afterAll(async () => {
  await cleanupFixtures(pool);
  await pool.end();
});

describe("P2-evidence: normalization and URL safety are deterministic", () => {
  it("normalizes case and whitespace identically", () => {
    expect(normalizeClaimText("  Portal   NEED\nconfirmed ")).toBe("portal need confirmed");
    expect(normalizeClaimText("Portal need confirmed")).toBe("portal need confirmed");
    expect(bundleHashOf([{ claimId: "a", textHash: "x" }])).toBe(
      bundleHashOf([{ claimId: "a", textHash: "x" }]),
    );
  });

  it("refuses non-http(s) and control-character URLs", () => {
    expect(safeSourceUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeSourceUrl("http://example.com/a")).toBe("http://example.com/a");
    expect(safeSourceUrl("javascript:alert(1)")).toBeNull();
    expect(safeSourceUrl("ftp://example.com/a")).toBeNull();
    expect(safeSourceUrl("https://example.com/a\nb")).toBeNull();
    expect(safeSourceUrl(null)).toBeNull();
  });

  it("performs no network I/O (stored evidence only)", () => {
    const src = readFileSync(join(process.cwd(), "lib", "qualification", "evidence.ts"), "utf8");
    for (const pat of [/[^a-zA-Z]fetch\s*\(/, /child_process/, /require\(["']http/, /from ["']http/]) {
      expect(src, `evidence.ts must not contain network access (${pat})`).not.toMatch(pat);
    }
  });
});

describe("P2-evidence: bundle building from stored rows", () => {
  it("builds usable items with trust, polarity and freshness", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "bundle", [
        { text: "Client intake runs on email threads", sourceKey: "company-site", predicate: "need-portal", observedDaysAgo: 10, link: "supports" },
        { text: "Team page lists twelve engineers", sourceKey: "agency-directory", observedDaysAgo: 400 },
      ]);
      const b = await buildEvidenceBundle(pool, s.companyId, {
        asOf: "2026-10-15T00:00:00.000Z",
        signalMap: { "need-portal": "need" },
        freshnessDefaultDays: 90,
      });
      expect(b.items).toHaveLength(2);
      expect(b.ambiguousEntity).toBe(false);
      const need = b.items.find((i) => i.signalFamily === "need")!;
      expect(need.polarity).toBe("supports");
      expect(need.freshness).toBe("current");
      expect(need.trustGrade).toBe("B");
      expect(need.approved).toBe(true);
      const old = b.items.find((i) => i.signalFamily === null)!;
      expect(old.freshness).toBe("stale");
      expect(b.usable).toHaveLength(2);
      expect(b.duplicates).toEqual([]);
      expect(b.unapproved).toEqual([]);
    } finally {
      await cleanupFixtures(pool);
      await registerFixtureSet(pool, "ev");
    }
  });

  it("collapses same-source re-ingest and same-announcement republication", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "dupe", [
        { text: "We build portals for clients", sourceKey: "company-site", observedDaysAgo: 5 },
        { text: "  WE BUILD portals for CLIENTS ", sourceKey: "company-site", observedDaysAgo: 6 },
        { text: "we build portals for clients", sourceKey: "agency-directory", observedDaysAgo: 7 },
      ]);
      const b = await buildEvidenceBundle(pool, s.companyId, { asOf: "2026-10-15T00:00:00.000Z" });
      // company-site and agency-directory are DIFFERENT independence groups
      // (web vs directories): same source twice collapses, cross-source stays.
      expect(b.duplicates.map((d) => d.reason).sort()).toEqual(["duplicate_same_source"]);
      expect(b.usable).toHaveLength(2);
      // Same text from two sources in the SAME group collapses instead.
      await pool.query(
        "update p2.source_trust set independence_group = 'web' where source_key = 'agency-directory'",
      );
      const b2 = await buildEvidenceBundle(pool, s.companyId, { asOf: "2026-10-15T00:00:00.000Z" });
      expect(b2.duplicates.map((d) => d.reason).sort()).toEqual([
        "duplicate_same_announcement",
        "duplicate_same_source",
      ]);
      expect(b2.usable).toHaveLength(1);
    } finally {
      await cleanupFixtures(pool);
      await registerFixtureSet(pool, "ev");
    }
  });

  it("excludes unapproved sources, expired claims and suppressed snapshots", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "excl", [
        { text: "Approved claim", sourceKey: "company-site", observedDaysAgo: 5 },
        { text: "Unapproved source claim", sourceKey: "x-platform", observedDaysAgo: 5 },
        { text: "Expired claim", sourceKey: "company-site", observedDaysAgo: 400, expiresInDays: -30 },
        { text: "Suppressed claim", sourceKey: "company-site", observedDaysAgo: 5, suppressedSnapshot: true },
      ]);
      const b = await buildEvidenceBundle(pool, s.companyId, { asOf: "2026-10-15T00:00:00.000Z" });
      expect(b.items).toHaveLength(2);
      expect(b.usable).toHaveLength(1);
      expect(b.unapproved).toHaveLength(1);
      expect(b.unapproved[0].reason).toMatch(/not approved for scoring/);
      expect(b.expired).toHaveLength(2);
      expect(b.expired.map((e) => e.reason).join(" ")).toMatch(/suppressed/);
    } finally {
      await cleanupFixtures(pool);
      await registerFixtureSet(pool, "ev");
    }
  });

  it("labels approved low-confidence sources and represents contradictions", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "lowc", [
        { text: "Hiring portal engineers", sourceKey: "hiring-platform", predicate: "timing-hire", observedDaysAgo: 5 },
        { text: "Client login already live", sourceKey: "company-site", link: "contradicts", observedDaysAgo: 5 },
      ]);
      const b = await buildEvidenceBundle(pool, s.companyId, {
        asOf: "2026-10-15T00:00:00.000Z",
        signalMap: { "timing-hire": "timing-cue" },
      });
      const low = b.items.find((i) => i.sourceKey === "hiring-platform")!;
      expect(low.approved).toBe(true);
      expect(low.lowConfidence).toBe(true);
      expect(low.trustGrade).toBe("C");
      const contra = b.items.find((i) => i.polarity === "contradicts")!;
      expect(contra.textHash).toBeTruthy();
      expect(b.usable.length).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanupFixtures(pool);
      await registerFixtureSet(pool, "ev");
    }
  });

  it("entity ambiguity overrides match confidence", async () => {
    try {
      const s = await seedCompanyWithClaims(
        pool,
        "ambig",
        [{ text: "Has an LEI record", sourceKey: "registry-generic", predicate: "identity", observedDaysAgo: 5 }],
        { registryId: "5493001KJTIIGC8Y1R12", countryCode: "DE" },
      );
      const clean = await buildEvidenceBundle(pool, s.companyId, { asOf: "2026-10-15T00:00:00.000Z" });
      expect(clean.items[0].entityConfidence).toBe("registry");
      // An open identity conflict makes every item ambiguous, however strong.
      await pool.query(
        `insert into public.identity_conflict
           (run_id, source_record_id, company_id, rule, detail, observed_name)
         values ((select id from public.discovery_run limit 1), 'p2t-ambig', $1, 'domain_exact', 'p2t', 'X')`,
        [s.companyId],
      );
      const amb = await buildEvidenceBundle(pool, s.companyId, { asOf: "2026-10-15T00:00:00.000Z" });
      expect(amb.ambiguousEntity).toBe(true);
      expect(amb.items[0].entityConfidence).toBe("ambiguous");
    } finally {
      await pool.query("delete from public.identity_conflict where source_record_id = 'p2t-ambig'");
      await cleanupFixtures(pool);
      await registerFixtureSet(pool, "ev");
    }
  });
});

describe("P2-evidence: negative findings record searches, not absences", () => {
  it("refuses incomplete searches and records complete ones", async () => {
    try {
      const s = await seedCompanyWithClaims(pool, "neg", [
        { text: "Some claim", sourceKey: "company-site", observedDaysAgo: 5 },
      ]);
      const row = await readQualificationRow(pool, (await seedOpp(pool, s.companyId)).opportunityId);
      const { ensureCase: ec } = await import("../lib/qualification/cases");
      const { kase } = await ec(pool, row!, ACTOR);
      const { recordSnapshot: rs } = await import("../lib/qualification/cases");
      const snap = await rs(pool, kase.case_id, row!, ACTOR, "negative-test");
      await expect(
        recordNegativeFinding(pool, {
          caseId: kase.case_id,
          snapshotId: snap.snapshotId,
          question: "Any client login?",
          searchedWhere: "",
          searchedAt: "2026-10-15T00:00:00.000Z",
          method: "manual site review",
          actor: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "incomplete_negative_finding" });
      const good = await recordNegativeFinding(pool, {
        caseId: kase.case_id,
        snapshotId: snap.snapshotId,
        question: "Any client login?",
        searchedWhere: "company-site services page + pricing page",
        searchedAt: "2026-10-15T00:00:00.000Z",
        method: "manual site review of two pages",
        actor: ACTOR,
      });
      expect(good.findingId).toBeTruthy();
    } finally {
      await cleanupFixtures(pool);
      await registerFixtureSet(pool, "ev");
    }
  });
});

async function seedOpp(pool: Pool, companyId: string): Promise<{ opportunityId: string }> {
  const { registerOpportunity } = await import("../lib/discovery/opportunities");
  const stamp = Date.now();
  const o = await registerOpportunity(pool, {
    pipeline: "agency_partner",
    sourceKey: "company-site",
    sourceRecordId: `P2T-NEG-${stamp}`,
    companyId,
    actor: ACTOR,
  });
  return { opportunityId: o.id };
}
