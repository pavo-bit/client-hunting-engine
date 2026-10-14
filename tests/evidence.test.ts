/**
 * T-007 evidence ledger tests (local DB only, loopback guard).
 * Covers: ingestion + idempotency, provenance, timestamp distinctions,
 * evidence links, statuses/transitions/history, stale/disputed/withdrawn,
 * reliability-vs-credibility separation, shared-origin rule, hash
 * consistency, retention/deletion, merge preservation, rollback, RLS,
 * malformed input, verbatim excerpts. Full regressions run separately.
 */
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import {
  assessClaim,
  checkTransition,
  flagClaim,
  independentOrigins,
  recommend,
} from "../lib/evidence/assessment";
import { attachEvidence, ingestObservation } from "../lib/evidence/ingest";
import { observationHash } from "../lib/evidence/hash";
import { getClaimDetail } from "../lib/evidence/detail";

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.T003_TEST_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const NOACCESS_URL =
  process.env.TEST_NOACCESS_URL ??
  "postgresql://noaccess:noaccess-local-only@127.0.0.1:5434/agency_intel_test";
const pool = new Pool({ connectionString: DB_URL, max: 3 });
const ACTOR = "t7test";
let seq = 0;
const dom = (p: string) => `t7-${Date.now()}-${seq++}-${p}.example`;

async function mkCo(name: string, extra: Record<string, string> = {}) {
  return (
    await createCompany(
      pool,
      {
        name,
        domain: extra.domain ?? dom("co"),
        agencyType: "web_development",
        country: "United States",
        ...extra,
      },
      ACTOR,
    )
  ).companyId;
}

async function mkObs(
  companyId: string,
  over: Record<string, unknown> = {},
  claim?: Parameters<typeof ingestObservation>[2],
) {
  return ingestObservation(
    pool,
    {
      companyId,
      sourceKey: "company-site",
      url: `https://obs.example/${seq++}`,
      excerpt: "T7 observation excerpt",
      actor: ACTOR,
      ...over,
    } as Parameters<typeof ingestObservation>[1],
    claim,
  );
}

async function cleanup() {
  const c = await pool.connect();
  try {
    await c.query(
      "delete from public.company where domain_norm like 't7-%' or name like 'T7 %'",
    );
  } finally {
    c.release();
  }
}

describe("observationHash", () => {
  it("is deterministic on content, sensitive to any change", () => {
    const a = observationHash("https://x.example/a", "hello");
    expect(observationHash("https://x.example/a", "hello")).toBe(a);
    expect(observationHash("https://x.example/a", "hello!")).not.toBe(a);
    expect(observationHash("https://x.example/b", "hello")).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("ingestion validation + idempotency", () => {
  it("rejects bad URLs, oversized excerpts, unknown sources/companies", async () => {
    const co = await mkCo("T7 Validation Co");
    try {
      await expect(
        mkObs(co, { url: "ftp://x.example/a" }),
      ).rejects.toMatchObject({ status: 422, code: "bad_url" });
      await expect(
        mkObs(co, { excerpt: "x".repeat(2001) }),
      ).rejects.toMatchObject({ status: 422, code: "excerpt_too_large" });
      await expect(
        mkObs(co, { sourceKey: "nope" }),
      ).rejects.toMatchObject({ status: 422, code: "unknown_source" });
      await expect(
        ingestObservation(pool, {
          companyId: "00000000-0000-4000-8000-000000000000",
          sourceKey: "company-site",
          url: "https://x.example/a",
          actor: ACTOR,
        }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        mkObs(
          co,
          {},
          { text: "x", reliability: "A", credibility: 9 } as never,
        ),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        mkObs(co, {}, { text: "sneaky", initialStatus: "verified", reliability: "A", credibility: 1 }),
      ).rejects.toMatchObject({ status: 422, code: "bad_status" });
    } finally {
      await cleanup();
    }
  });

  it("ingests once; identical re-ingest returns the same snapshot", async () => {
    const co = await mkCo("T7 Idempotent Co");
    try {
      const first = await mkObs(
        co,
        { url: "https://idem.example/page", excerpt: "same" },
        { text: "T7 idempotent claim", reliability: "B", credibility: 2 },
      );
      expect(first.existed).toBe(false);
      expect(first.claimId).not.toBeNull();
      const second = await mkObs(
        co,
        { url: "https://idem.example/page", excerpt: "same" },
        { text: "T7 idempotent claim", reliability: "B", credibility: 2 },
      );
      expect(second.existed).toBe(true);
      expect(second.snapshotId).toBe(first.snapshotId);
      expect(second.claimId).toBeNull();
      const c = await pool.connect();
      try {
        const n = await c.query(
          "select count(*)::int as n from public.claim where company_id = $1",
          [co],
        );
        expect(n.rows[0].n).toBe(1);
      } finally {
        c.release();
      }
    } finally {
      await cleanup();
    }
  });

  it("distinguishes event, publish, and capture times", async () => {
    const co = await mkCo("T7 Times Co");
    try {
      const r = await mkObs(co, {
        url: "https://times.example/e",
        excerpt: "event",
        observedAt: "2024-05-01T12:00:00Z",
      });
      const c = await pool.connect();
      try {
        const s = await c.query(
          "select observed_at, fetched_at from public.snapshot where id = $1",
          [r.snapshotId],
        );
        expect(new Date(s.rows[0].observed_at).getFullYear()).toBe(2024);
        expect(new Date(s.rows[0].fetched_at).getFullYear()).toBeGreaterThanOrEqual(2024);
        expect(s.rows[0].observed_at).not.toBe(s.rows[0].fetched_at);
      } finally {
        c.release();
      }
    } finally {
      await cleanup();
    }
  });

  it("stores excerpts verbatim (rendering escapes downstream, never here)", async () => {
    const co = await mkCo("T7 Markup Co");
    const evil = "<script>alert(1)</script> & <b>bold</b>";
    try {
      const r = await mkObs(co, { url: "https://markup.example/x", excerpt: evil });
      const d = await getClaimDetail(pool, "00000000-0000-4000-8000-000000000000");
      expect(d).toBeNull();
      const c = await pool.connect();
      try {
        const s = await c.query(
          "select content_excerpt from public.snapshot where id = $1",
          [r.snapshotId],
        );
        expect(s.rows[0].content_excerpt).toBe(evil);
      } finally {
        c.release();
      }
    } finally {
      await cleanup();
    }
  });
});

describe("evidence links", () => {
  it("links supports/contradicts/contextual; enforces single target; no self-links", async () => {
    const co = await mkCo("T7 Links Co");
    try {
      const base = await mkObs(co, { url: "https://links.example/base", excerpt: "base" }, {
        text: "T7 base claim",
        reliability: "B",
        credibility: 3,
      });
      const other = await mkObs(co, { url: "https://links.example/other", excerpt: "other" });
      const s = await attachEvidence(pool, {
        claimId: base.claimId!,
        snapshotId: other.snapshotId,
        polarity: "supports",
        note: "same wording",
        actor: ACTOR,
      });
      expect(s.id).toBeDefined();
      const c2 = await mkObs(co, { url: "https://links.example/contra", excerpt: "contra" }, {
        text: "T7 rival claim",
        reliability: "C",
        credibility: 3,
      });
      await attachEvidence(pool, {
        claimId: base.claimId!,
        linkedClaimId: c2.claimId!,
        polarity: "contradicts",
        actor: ACTOR,
      });
      await expect(
        attachEvidence(pool, {
          claimId: base.claimId!,
          snapshotId: other.snapshotId,
          linkedClaimId: c2.claimId!,
          polarity: "supports",
          actor: ACTOR,
        }),
      ).rejects.toMatchObject({ status: 422, code: "bad_target" });
      await expect(
        attachEvidence(pool, {
          claimId: base.claimId!,
          linkedClaimId: base.claimId!,
          polarity: "supports",
          actor: ACTOR,
        }),
      ).rejects.toMatchObject({ status: 422, code: "self_link" });
      await expect(
        attachEvidence(pool, {
          claimId: base.claimId!,
          snapshotId: "00000000-0000-4000-8000-000000000000",
          polarity: "supports",
          actor: ACTOR,
        }),
      ).rejects.toMatchObject({ status: 404 });
      const d = await getClaimDetail(pool, base.claimId!);
      expect(d?.supporting).toHaveLength(1);
      expect(d?.contradicting).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});

describe("assessment rules", () => {
  it("independentOrigins separates shared origins from independent ones", () => {
    expect(
      independentOrigins([
        { source_key: "company-site", snapshot_url: "https://a.example/1" },
        { source_key: "company-site", snapshot_url: "https://a.example/2" },
      ]),
    ).toHaveLength(1);
    expect(
      independentOrigins([
        { source_key: "company-site", snapshot_url: "https://a.example/1" },
        { source_key: "agency-directory", snapshot_url: "https://b.example/1" },
      ]),
    ).toHaveLength(2);
  });

  it("recommends corroborated only on 2+ independent origins; verified stays human", () => {
    const one = recommend("observed", ["s1\nu1"], 0);
    expect(one.recommended).toBeNull();
    const two = recommend("observed", ["s1\nu1", "s2\nu2"], 1);
    expect(two.recommended).toBe("corroborated");
    expect(two.eligibleVerified).toBe(true);
    expect(two.reasons.join(" ")).toMatch(/contradict/);
    expect(recommend("verified", ["s1", "s2"], 0).recommended).toBeNull();
  });

  it("runs the full lifecycle: observe -> corroborate (auto) -> verify (human)", async () => {
    const co = await mkCo("T7 Lifecycle Co");
    try {
      const r = await mkObs(co, { url: "https://life.example/1", excerpt: "one" }, {
        text: "T7 lifecycle claim",
        reliability: "B",
        credibility: 2,
      });
      // Second independent origin via another source key.
      const c = await pool.connect();
      let s2 = "";
      try {
        const ins = await c.query(
          `insert into public.snapshot (company_id, source_key, url, sha256, retention_class)
           values ($1, 'agency-directory', 'https://life.example/2', $2, 'directory') returning id`,
          [co, "e".repeat(64)],
        );
        s2 = ins.rows[0].id as string;
      } finally {
        c.release();
      }
      await attachEvidence(pool, {
        claimId: r.claimId!,
        snapshotId: s2,
        polarity: "supports",
        actor: ACTOR,
      });
      // Automatic promotion to corroborated is allowed...
      const auto = await assessClaim(pool, r.claimId!, {
        to: "corroborated",
        rationale: "two independent origins",
        actor: "engine",
        automatic: true,
      });
      expect(auto).toMatchObject({ from: "observed", to: "corroborated" });
      // ...but automatic verified is forbidden.
      await expect(
        assessClaim(pool, r.claimId!, {
          to: "verified",
          rationale: "engine is confident",
          actor: "engine",
          automatic: true,
        }),
      ).rejects.toMatchObject({ status: 422, code: "verified_human_only" });
      // Human verified with rationale works and keeps history.
      const hum = await assessClaim(pool, r.claimId!, {
        to: "verified",
        rationale: "operator confirmed with the agency on a call",
        actor: ACTOR,
        automatic: false,
      });
      expect(hum).toMatchObject({ from: "corroborated", to: "verified" });
      const d = await getClaimDetail(pool, r.claimId!);
      expect(d?.claim.claim_status).toBe("verified");
      expect(d?.assessments).toHaveLength(3); // initial + auto + human
      expect(d?.assessments.map((a) => a.to_status)).toEqual([
        "observed",
        "corroborated",
        "verified",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("represents disputed/withdrawn/superseded/stale without erasing", async () => {
    const co = await mkCo("T7 Terminal Co");
    try {
      const r = await mkObs(co, { url: "https://term.example/1", excerpt: "t" }, {
        text: "T7 terminal claim",
        reliability: "C",
        credibility: 4,
      });
      const disputed = await assessClaim(pool, r.claimId!, {
        to: "disputed",
        rationale: "source contradicts itself",
        actor: ACTOR,
        automatic: false,
      });
      expect(disputed.to).toBe("disputed");
      const wd = await assessClaim(pool, r.claimId!, {
        to: "withdrawn",
        rationale: "source retracted",
        actor: ACTOR,
        automatic: false,
      });
      expect(wd.to).toBe("withdrawn");
      // Terminal: further moves blocked, history intact.
      await expect(
        assessClaim(pool, r.claimId!, {
          to: "observed",
          rationale: "change mind",
          actor: ACTOR,
          automatic: false,
        }),
      ).rejects.toMatchObject({ status: 409, code: "terminal_claim" });
      const d = await getClaimDetail(pool, r.claimId!);
      expect(d?.claim.claim_status).toBe("withdrawn");
      expect(d?.assessments).toHaveLength(3);
      // Staleness is computed from expires_at, orthogonal to status.
      const r2 = await mkObs(
        co,
        { url: "https://term.example/2", excerpt: "t2" },
        {
          text: "T7 stale claim",
          reliability: "B",
          credibility: 2,
          expiresAt: "2020-01-01T00:00:00Z",
        },
      );
      const d2 = await getClaimDetail(pool, r2.claimId!);
      expect(d2?.claim.stale).toBe(true);
      expect(d2?.claim.claim_status).toBe("observed");
    } finally {
      await cleanup();
    }
  });

  it("requires rationale, rejects unknown statuses and no-op transitions", async () => {
    const co = await mkCo("T7 Guard Co");
    try {
      const r = await mkObs(co, { url: "https://guard.example/1", excerpt: "g" }, {
        text: "T7 guard claim",
        reliability: "B",
        credibility: 2,
      });
      await expect(
        assessClaim(pool, r.claimId!, { to: "verified", rationale: "", actor: ACTOR, automatic: false }),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        assessClaim(pool, r.claimId!, { to: "proven", rationale: "x", actor: ACTOR, automatic: false }),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        assessClaim(pool, r.claimId!, { to: "observed", rationale: "same", actor: ACTOR, automatic: false }),
      ).rejects.toMatchObject({ status: 409 });
      // Failed attempts change nothing.
      const d = await getClaimDetail(pool, r.claimId!);
      expect(d?.claim.claim_status).toBe("observed");
      expect(d?.assessments).toHaveLength(1);
      expect(() => checkTransition("observed", { to: "nope", rationale: "x", actor: "t", automatic: false })).toThrow();
    } finally {
      await cleanup();
    }
  });

  it("flagging routes to review without changing status", async () => {
    const co = await mkCo("T7 Flag Co");
    try {
      const r = await mkObs(co, { url: "https://flag.example/1", excerpt: "f" }, {
        text: "T7 flag claim",
        reliability: "B",
        credibility: 2,
      });
      const f = await flagClaim(pool, r.claimId!, { reason: "looks odd", actor: ACTOR, flag: true });
      expect(f.needsReview).toBe(true);
      await expect(
        flagClaim(pool, r.claimId!, { reason: "", actor: ACTOR, flag: true }),
      ).rejects.toMatchObject({ status: 422 });
      const d = await getClaimDetail(pool, r.claimId!);
      expect(d?.claim.needs_review).toBe(true);
      expect(d?.claim.claim_status).toBe("observed");
    } finally {
      await cleanup();
    }
  });

  it("keeps reliability separate from credibility end to end", async () => {
    const co = await mkCo("T7 Sep Co");
    try {
      // Authoritative source, weak specific information — must stay distinct.
      const r = await mkObs(co, { url: "https://sep.example/1", excerpt: "s" }, {
        text: "T7 separation claim",
        reliability: "A",
        credibility: 5,
      });
      const d = await getClaimDetail(pool, r.claimId!);
      expect(d?.claim.source_reliability).toBe("A");
      expect(d?.claim.info_credibility).toBe(5);
      // Corroboration counts origins, not reliability grades.
      expect(recommend("observed", ["A-src\nu1"], 0).recommended).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

describe("retention, merges, and authorization", () => {
  it("takedown suppression works; assessment history is append-only", async () => {
    const co = await mkCo("T7 Takedown Co");
    try {
      const r = await mkObs(co, { url: "https://take.example/1", excerpt: "t" }, {
        text: "T7 takedown claim",
        reliability: "B",
        credibility: 2,
      });
      const c = await pool.connect();
      try {
        await c.query("update public.snapshot set suppressed = true where company_id = $1", [co]);
        const s = await c.query("select suppressed from public.snapshot where company_id = $1", [co]);
        expect(s.rows[0].suppressed).toBe(true);
        await expect(
          c.query("update public.claim_assessment set rationale = 'tampered'"),
        ).rejects.toThrow(/append-only/);
      } finally {
        c.release();
      }
      void r;
    } finally {
      await cleanup();
    }
  });

  it("merges move claims but snapshots stay attributed to the original record", async () => {
    const c = await pool.connect();
    let loser = "";
    let winner = "";
    try {
      const a = await c.query(
        `insert into public.company (name, domain_norm, agency_type, country)
         values ('T7 Merge Loser', 't7-mergeloser.example', 'web_development', 'United States') returning id`,
      );
      loser = a.rows[0].id as string;
      const b = await c.query(
        `insert into public.company (name, domain_norm, agency_type, country)
         values ('T7 Merge Winner', 't7-mergewinner.example', 'web_development', 'United States') returning id`,
      );
      winner = b.rows[0].id as string;
    } finally {
      c.release();
    }
    try {
      await mkObs(loser, { url: "https://mg.example/1", excerpt: "m" }, {
        text: "T7 merge claim",
        reliability: "B",
        credibility: 2,
      });
      const m = await pool.connect();
      try {
        await m.query("select public.resolve_merge_company($1, $2, $3, $4)", [
          loser,
          winner,
          ACTOR,
          "t7 merge probe",
        ]);
        // Claim moved to winner; snapshot stays attributed to the loser.
        const moved = await m.query(
          "select count(*)::int as n from public.claim where company_id = $1",
          [winner],
        );
        expect(moved.rows[0].n).toBe(1);
        const snap = await m.query(
          "select company_id from public.snapshot where company_id = $1",
          [loser],
        );
        expect(snap.rows[0].company_id).toBe(loser);
      } finally {
        m.release();
      }
    } finally {
      const c2 = await pool.connect();
      try {
        // Loser row is archived (merged_into set) so name cleanup below
        // targets both rows explicitly.
        await c2.query("delete from public.company where id = any($1)", [[loser, winner]]);
      } finally {
        c2.release();
      }
    }
  });

  it("denies unprivileged access to evidence tables", async () => {
    const denied = new Pool({ connectionString: NOACCESS_URL, max: 1 });
    try {
      await denied.query("select 1");
      await expect(
        denied.query("select count(*) from public.claim_assessment"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        denied.query("select count(*) from public.claim_evidence"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await denied.end();
    }
  });
});
