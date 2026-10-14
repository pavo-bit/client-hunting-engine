/**
 * T-012 unified review queue tests (local DB only, loopback guard).
 *
 * Covers: every implemented queue source, status->priority mapping, stable-key
 * uniqueness, deterministic ordering + tie-breaks, filters / bounded
 * pagination / search, stale detection, items entering and leaving the queue
 * after domain transitions, reopening after material change, merged-record
 * exclusion, read-only proof (audit invariance), delegation links, partial
 * source failure, concurrent domain updates, missing records, authorization,
 * and privacy of outreach bodies. Full T-002..T-011 regressions run separately.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { assessClaim, flagClaim } from "../lib/evidence/assessment";
import { attachEvidence, ingestObservation } from "../lib/evidence/ingest";
import { decideHypothesis, generateHypotheses } from "../lib/hypothesis/rules";
import { createProposal, decideProposal } from "../lib/proposal/proposals";
import { createBrief, decideBrief, getBriefWorkspace } from "../lib/sales/briefs";
import { createDraft } from "../lib/sales/drafts";
import { evaluateHypothesis, rankedOpportunities } from "../lib/scoring/evaluate";
import {
  decideCandidate,
  findCandidates,
  reopenCandidate,
} from "../lib/resolve/engine";
import {
  MAX_LIMIT,
  QUEUE_DOMAINS,
  QUEUE_PARTS,
  getReviewQueue,
  type QueueItem,
} from "../lib/review/queue";

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
const ACTOR = "t12test";
let seq = 0;
const dom = (p: string) => `t12-${Date.now()}-${seq++}-${p}.example`;

const PROPOSAL = {
  title: "T12 Pilot",
  scopeIn: "Intake form, status page",
  scopeOut: "Billing migration",
  feasibility: "medium" as const,
  assumptions: "Agency confirms email intake",
  items: [{ name: "Intake form", complexity: "M" as const, kind: "feature" as const }],
  contingencyPct: 15,
  actor: ACTOR,
};

async function mkCo(name: string, extra: Record<string, string> = {}) {
  return (
    await createCompany(
      pool,
      { name, domain: dom("co"), agencyType: "web_development", country: "United States", ...extra },
      ACTOR,
    )
  ).companyId;
}

async function mkClaim(
  companyId: string,
  text: string,
  opts: { predicate?: string; stale?: boolean } = {},
) {
  const r = await ingestObservation(
    pool,
    {
      companyId,
      sourceKey: "company-site",
      url: `https://q12.example/${seq++}`,
      excerpt: text.slice(0, 300),
      actor: ACTOR,
    },
    {
      predicate: opts.predicate ?? "announced",
      text,
      reliability: "B",
      credibility: 2,
      ...(opts.stale ? { expiresAt: "2020-01-01T00:00:00Z" } : {}),
    },
  );
  return r.claimId!;
}

interface FullHouse {
  co: string;
  twin: string;
  portalHyp: string;
  hiringHyp: string;
  reviewProp: string;
  briefRef: string;
  apiClaim: string;
}

/**
 * One company exercising every implemented queue source. Conflicting registry
 * IDs under one jurisdiction produce a BLOCKING identity item; a real
 * contradiction produces a needs_review hypothesis; an accepted proposal and
 * its draft brief produce the sales sources.
 */
async function mkFullHouse(): Promise<FullHouse> {
  const co = await mkCo("T12 Full House", {
    registryId: "HRB-T12-A",
    country: "Germany",
    countryCode: "DE",
  });
  await mkClaim(co, "Client portal onboarding announced");
  const apiClaim = await mkClaim(co, "Wants API integration with partner tools");
  await mkClaim(co, "Agency is hiring two developers", { predicate: "hiring" });
  const repA = await mkClaim(co, "Client reporting handled by spreadsheet exports");
  const repB = await mkClaim(co, "Client reporting dashboard already live internally");
  await attachEvidence(pool, {
    claimId: repA,
    linkedClaimId: repB,
    polarity: "contradicts",
    actor: ACTOR,
  });
  await flagClaim(pool, apiClaim, { reason: "operator wants a second look", flag: true, actor: ACTOR });
  const disputed = await mkClaim(co, "Portal rollout already completed everywhere");
  await assessClaim(pool, disputed, {
    to: "disputed",
    rationale: "two sources disagree",
    actor: ACTOR,
    automatic: false,
  });
  await mkClaim(co, "Historic onboarding announcement", { stale: true });

  const gen = await generateHypotheses(pool, co, ACTOR);
  const byRule = (ruleId: string): string => {
    const h = gen.hypotheses.find((x) => x.ruleId === ruleId);
    if (!h) throw new Error(`fixture: rule ${ruleId} did not fire`);
    return h.id;
  };
  const portalHyp = byRule("R-PORTAL-01");
  const hiringHyp = byRule("R-HIRING-01");
  byRule("R-REPORTING-01"); // must exist: needs_review (contradiction) hypothesis source
  byRule("R-INTEGRATION-01"); // must exist: generated -> gates source

  // Proposal parked in review (proposal source). Scored BEFORE the identity
  // conflict exists — the identity-clear gate would otherwise refuse it, which
  // is exactly the behaviour the gates queue source surfaces.
  await decideHypothesis(pool, portalHyp, { decision: "validate", reason: "t12 portal", actor: ACTOR });
  const reviewProp = await createProposal(pool, { ...PROPOSAL, hypothesisId: portalHyp });
  await decideProposal(pool, reviewProp.id, { decision: "submit", reason: "t12 ready", actor: ACTOR });
  await evaluateHypothesis(pool, portalHyp, ACTOR);

  // Accepted proposal + draft brief + outreach draft blocked on unverified
  // assertions (brief + draft sources).
  await decideHypothesis(pool, hiringHyp, { decision: "validate", reason: "t12 hiring", actor: ACTOR });
  const okProp = await createProposal(pool, { ...PROPOSAL, title: "T12 Accepted Pilot", hypothesisId: hiringHyp });
  await decideProposal(pool, okProp.id, { decision: "submit", reason: "t12 ready", actor: ACTOR });
  await decideProposal(pool, okProp.id, { decision: "accept", reason: "t12 pursue", actor: ACTOR });
  const brief = await createBrief(pool, { proposalId: okProp.id, actor: ACTOR });
  await createDraft(pool, {
    briefRef: brief.ref,
    channel: "email",
    body: "CONFIDENTIAL-BODY-MARKER — human sends only",
    unverifiedPoints: "ROI claim (unproven)",
    actor: ACTOR,
  });

  // Catalog entry awaiting the owner (catalog source, D-004/D-005).
  const c = await pool.connect();
  try {
    await c.query(
      `insert into public.capability (key, name, is_placeholder, status)
       values ('t12-cap', 'T12 Draft Capability', true, 'needs_owner_review')
       on conflict (key) do nothing`,
    );
  } finally {
    c.release();
  }

  // Same normalized name, different registry, same jurisdiction -> conflicting.
  // NOTE: the registry prefix is deliberately NOT `RX-`: tests/resolve.test.ts
  // cleans up on `registry_id like 'RX-%'`, and cross-file cleanup collisions
  // would delete these fixtures mid-test.
  const twin = await mkCo("T12 Full House Ltd", {
    registryId: "HRB-T12-B",
    country: "Germany",
    countryCode: "DE",
  });
  await findCandidates(pool, twin, { actor: ACTOR, autoMerge: false });

  return { co, twin, portalHyp, hiringHyp, reviewProp: reviewProp.id, briefRef: brief.ref, apiClaim };
}

async function cleanup() {
  const c = await pool.connect();
  try {
    await c.query(
      `delete from public.hypothesis_evidence where hypothesis_id in (
         select id from public.hypothesis where company_id in (
           select id from public.company
           where domain_norm like 't12-%' or name like 'T12 %'))`,
    );
    await c.query(
      `delete from public.company
       where domain_norm like 't12-%' or registry_id like 'HRB-T12-%' or name like 'T12 %'`,
    );
    await c.query("delete from public.capability where key = 't12-cap'");
  } finally {
    c.release();
  }
}

// Residue guard: never let a failed fixture leak registry IDs into the next test.
beforeAll(async () => {
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  await pool.end();
});

const rank = (p: string) =>
  ["blocking", "high", "normal", "low", "informational"].indexOf(p);

describe("queue sources", () => {
  it("projects every implemented workflow with unique stable keys", async () => {
    try {
      await mkFullHouse();
      const q = await getReviewQueue(pool, { limit: 200 });
      expect(q.partial).toBe(false);
      expect(q.failedSources).toEqual([]);

      const byDomain = new Map<string, number>();
      for (const it of q.items) byDomain.set(it.domain, (byDomain.get(it.domain) ?? 0) + 1);
      for (const d of QUEUE_DOMAINS) {
        if (d === "stale") continue; // covered by the staleness tests below
        expect(byDomain.get(d) ?? 0, `domain ${d}`).toBeGreaterThan(0);
      }

      const keys = q.items.map((i) => i.key);
      expect(new Set(keys).size, "queue keys must be unique").toBe(keys.length);
      for (const it of q.items) {
        expect(it.key).toMatch(/^[a-z]+:[a-z-]+:/);
        expect(it.recordId.length).toBeGreaterThan(0);
        expect(it.why.length).toBeGreaterThan(10);
        expect(it.title.length).toBeGreaterThan(3);
        // Domain status is reported verbatim, never invented.
        expect(it.status.length).toBeGreaterThan(0);
      }
    } finally {
      await cleanup();
    }
  });

  it("maps domain status to deterministic priority and orders the inbox", async () => {
    try {
      await mkFullHouse();
      const q = await getReviewQueue(pool, { company: "full house", limit: 200 });
      const rankOf = (it: QueueItem) => rank(it.priority);
      const ranks = q.items.map(rankOf);
      expect([...ranks].sort((a, b) => a - b), "priority rank must be ascending").toEqual(ranks);
      expect(q.items.map((i) => i.priority)).toContain("blocking");
      expect(q.items.map((i) => i.priority)).toContain("high");

      // Tie-break: oldest updatedAt first, then key ascending.
      for (let i = 1; i < q.items.length; i++) {
        const prev = q.items[i - 1];
        const cur = q.items[i];
        if (rankOf(prev) !== rankOf(cur)) continue;
        if (prev.updatedAt === cur.updatedAt) expect(prev.key < cur.key, `${prev.key} < ${cur.key}`).toBe(true);
        else expect(prev.updatedAt < cur.updatedAt, `${prev.updatedAt} < ${cur.updatedAt}`).toBe(true);
      }

      // Re-reading returns byte-identical ordering (determinism).
      const again = await getReviewQueue(pool, { company: "full house", limit: 200 });
      expect(again.items.map((i) => i.key)).toEqual(q.items.map((i) => i.key));
    } finally {
      await cleanup();
    }
  });

  it("never lets an opportunity score drive queue priority", async () => {
    try {
      const h = await mkFullHouse();
      const q = await getReviewQueue(pool, { limit: 200 });
      // Blocking priority is reserved for integrity and identity problems only —
      // never for commercial attractiveness.
      const BLOCKING_TYPES = [
        "duplicate-candidate",
        "gate-identity-block",
        "stale-approved-brief",
        "stale-accepted-proposal",
      ];
      const blocking = q.items.filter((i) => i.priority === "blocking");
      expect(blocking.length).toBeGreaterThan(0);
      for (const b of blocking) expect(BLOCKING_TYPES, `unexpected blocking type ${b.type}`).toContain(b.type);

      // A scored opportunity whose identity is unresolved is blocked by the
      // identity conflict itself, never by anything in its score.
      const gate = q.items.find((i) => i.type === "gate-identity-block" && i.recordId === h.co);
      expect(gate).toBeDefined();
      expect(gate?.priority).toBe("blocking");
      expect(gate?.why.toLowerCase()).toContain("identity");
      // No score total is ever copied into a queue item.
      expect(JSON.stringify(q.items)).not.toMatch(/"total"/);
    } finally {
      await cleanup();
    }
  });

  it("keeps every deep link inside a real workflow route", async () => {
    try {
      await mkFullHouse();
      const q = await getReviewQueue(pool, { limit: 200 });
      const known = ["/resolve", "/evidence/", "/hypotheses/", "/proposals/", "/briefs/", "/catalog", "/scores"];
      for (const it of q.items) expect(known.some((p) => it.href === p || it.href.startsWith(p))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("never exposes outreach bodies or operator notes in the queue", async () => {
    try {
      await mkFullHouse();
      const q = await getReviewQueue(pool, { limit: 200 });
      const drafts = q.items.filter((i) => i.domain === "draft");
      expect(drafts.length).toBeGreaterThan(0);
      for (const d of drafts) {
        expect(JSON.stringify(d)).not.toContain("CONFIDENTIAL-BODY-MARKER");
        expect(d.href).toBe(`/briefs/${d.title.match(/for (BR-[0-9-]+)/)?.[1] ?? ""}`);
      }
    } finally {
      await cleanup();
    }
  });
});

describe("filters, pagination, search", () => {
  it("filters by domain/priority/company, bounds pages, validates input", async () => {
    try {
      await mkFullHouse();
      const d = await getReviewQueue(pool, { domain: "brief", limit: 200 });
      expect(d.items.length).toBeGreaterThan(0);
      expect(d.items.every((i) => i.domain === "brief")).toBe(true);

      const p = await getReviewQueue(pool, { priority: "blocking", limit: 200 });
      expect(p.items.length).toBeGreaterThan(0);
      expect(p.items.every((i) => i.priority === "blocking")).toBe(true);

      const co = await getReviewQueue(pool, { company: "FULL HOUSE", limit: 200 });
      expect(co.items.length).toBeGreaterThan(0);
      expect(co.items.every((i) => (i.companyName ?? "").toLowerCase().includes("full house"))).toBe(true);

      const q = await getReviewQueue(pool, { q: "unverified", limit: 200 });
      expect(q.items.length).toBeGreaterThan(0);
      const miss = await getReviewQueue(pool, { q: "zzz-no-such-text", limit: 200 });
      expect(miss.items).toEqual([]);

      // Scoped to the fixture so page totals are stable no matter what other
      // rows exist in the shared local database.
      const p1 = await getReviewQueue(pool, { company: "full house", limit: 2, offset: 0 });
      const p2 = await getReviewQueue(pool, { company: "full house", limit: 2, offset: 2 });
      expect(p1.items).toHaveLength(2);
      expect(p1.total).toBe(p2.total);
      expect(p1.total).toBeGreaterThanOrEqual(4);
      expect(p1.items.map((i) => i.key)).not.toEqual(p2.items.map((i) => i.key));

      // Bounded: limit clamped, offset floored, garbage input never throws.
      const big = await getReviewQueue(pool, { limit: 99_999 });
      expect(big.items.length).toBeLessThanOrEqual(MAX_LIMIT);
      const neg = await getReviewQueue(pool, { limit: -5, offset: -9 });
      expect(neg.limit).toBe(1);
      expect(neg.offset).toBe(0);
      const nan = await getReviewQueue(pool, { limit: Number.NaN, offset: Number.NaN });
      expect(Number.isFinite(nan.limit)).toBe(true);
      expect(nan.offset).toBe(0);

      await expect(getReviewQueue(pool, { domain: "nope" })).rejects.toMatchObject({
        status: 422,
        code: "bad_domain",
      });
      await expect(getReviewQueue(pool, { priority: "urgent" })).rejects.toMatchObject({
        status: 422,
        code: "bad_priority",
      });

      // Search inputs are length-bounded, not injectable.
      const long = await getReviewQueue(pool, { q: "a".repeat(5_000), company: "b".repeat(5_000) });
      expect(long.total).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("returns an empty, non-error result when nothing matches", async () => {
    const q = await getReviewQueue(pool, { company: "zzz-no-such-company", limit: 50 });
    expect(q.items).toEqual([]);
    expect(q.total).toBe(0);
    expect(q.partial).toBe(false);
  });
});

describe("resolution, staleness, reopening", () => {
  it("drops an identity item once decided and resurfaces it when reopened", async () => {
    try {
      await mkFullHouse();
      const c = await pool.connect();
      let cand: string;
      try {
        const r = await c.query(
          `select m.id from public.match_candidate m
           join public.company a on a.id = m.company_a
           where m.status = 'pending' and a.name like 'T12 %' limit 1`,
        );
        cand = r.rows[0].id as string;
      } finally {
        c.release();
      }
      const before = await getReviewQueue(pool, { domain: "identity", limit: 200 });
      expect(before.items.find((i) => i.recordId === cand)).toBeDefined();
      expect(before.items.find((i) => i.recordId === cand)?.priority).toBe("blocking");

      await decideCandidate(pool, cand, { decision: "rejected", reason: "t12 distinct entities", actor: ACTOR });
      const after = await getReviewQueue(pool, { domain: "identity", limit: 200 });
      expect(after.items.find((i) => i.recordId === cand), "decided item leaves the queue").toBeUndefined();

      await reopenCandidate(pool, cand, { reason: "t12 new public contract found", actor: ACTOR });
      const back = await getReviewQueue(pool, { domain: "identity", limit: 200 });
      expect(back.items.find((i) => i.recordId === cand), "reopened item returns").toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it("removes an accepted candidate and hides the merged record entirely", async () => {
    const co = await mkCo("T12 Gone Digital");
    try {
      const twin = await mkCo("T12 Gone Digital Ltd");
      const r = await findCandidates(pool, twin, { actor: ACTOR, autoMerge: false });
      expect(r.candidates.length).toBeGreaterThan(0);
      await decideCandidate(pool, r.candidates[0].id, {
        decision: "accepted",
        reason: "t12 same agency",
        actor: ACTOR,
      });
      const c = await pool.connect();
      try {
        const gone = await c.query("select merged_into from public.company where id = $1", [twin]);
        expect(gone.rows[0].merged_into, "older record wins the merge").toBe(co);
      } finally {
        c.release();
      }
      const q = await getReviewQueue(pool, { company: "gone digital", limit: 200 });
      expect(q.items.every((i) => i.companyId !== twin), "merged-away record never surfaces").toBe(true);
      expect(q.items.every((i) => i.status !== "pending")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("flags an approved brief as stale without rewriting its approval", async () => {
    try {
      const h = await mkFullHouse();
      await decideBrief(pool, h.briefRef, { decision: "submit", reason: "t12 ready", actor: ACTOR });
      await decideBrief(pool, h.briefRef, { decision: "approve", reason: "t12 solid", actor: ACTOR });
      const q1 = await getReviewQueue(pool, { domain: "brief", limit: 200 });
      expect(q1.items.find((i) => i.recordId === h.briefRef), "approved brief leaves the review domain").toBeUndefined();
      expect((await getReviewQueue(pool, { domain: "stale", limit: 200 })).items.find((i) => i.recordId === h.briefRef)).toBeUndefined();

      // Material change after approval: a fresh hiring claim supersedes the
      // hypothesis the brief was built on (domain rule, not a queue rule).
      await mkClaim(h.co, "Agency is now hiring a third developer", { predicate: "hiring" });
      await generateHypotheses(pool, h.co, ACTOR);

      const q = await getReviewQueue(pool, { domain: "stale", limit: 200 });
      const mine = q.items.find((i) => i.recordId === h.briefRef);
      expect(mine, "approved-but-stale brief must resurface").toBeDefined();
      expect(mine?.priority).toBe("blocking");
      expect(mine?.stale).toBe(true);
      expect(mine?.status, "approval is never silently reset").toBe("approved");
      // The queue's verdict matches the owning workflow's own freshness check.
      const ws = await getBriefWorkspace(pool, h.briefRef);
      expect(ws?.stale).toBe(true);
      for (const reason of ws?.staleReasons ?? []) expect(mine?.why).toContain(reason);
    } finally {
      await cleanup();
    }
  });

  it("flags a stale score and agrees with the ranking workflow", async () => {
    try {
      const co = await mkCo("T12 Score Co", {
        registryId: "HRB-T12-S",
        country: "Spain",
        countryCode: "ES",
      });
      await mkClaim(co, "Client portal onboarding announced");
      const gen = await generateHypotheses(pool, co, ACTOR);
      const hyp = gen.hypotheses.find((h) => h.ruleId === "R-PORTAL-01")?.id;
      if (!hyp) throw new Error("fixture: R-PORTAL-01 did not fire");
      // `deferred` is a decided, still-eligible state: it can be scored, and
      // re-generation tops up its evidence links instead of superseding it.
      await decideHypothesis(pool, hyp, { decision: "defer", reason: "t12 park it", actor: ACTOR });
      await evaluateHypothesis(pool, hyp, ACTOR);
      const fresh = await getReviewQueue(pool, { domain: "stale", limit: 200 });
      expect(fresh.items.find((i) => i.recordId === hyp), "a fresh score is not stale").toBeUndefined();

      await mkClaim(co, "Another client portal onboarding announcement");
      await generateHypotheses(pool, co, ACTOR);

      const q = await getReviewQueue(pool, { domain: "stale", limit: 200 });
      const mine = q.items.find((i) => i.type === "stale-score" && i.recordId === hyp);
      expect(mine, "evidence after evaluation makes the score stale").toBeDefined();
      expect(mine?.stale).toBe(true);
      expect(mine?.priority).toBe("high");
      expect(mine?.why).toContain("score_v1");
      expect(mine?.why.toLowerCase()).toContain("re-evaluate");

      // The queue agrees with the ranking workflow's own staleness rule.
      const ranked = await rankedOpportunities(pool);
      const row = ranked.find((r) => r.hypothesis_id === hyp);
      expect(row, "fixture must stay rankable").toBeDefined();
      expect(row?.stale).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("leaves items out when nothing is actionable (resolved state)", async () => {
    try {
      await mkCo("T12 Quiet Co");
      const q = await getReviewQueue(pool, { company: "quiet co", limit: 200 });
      expect(q.items).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("serializes every timestamp to an ISO string (render safety)", async () => {
    try {
      await mkFullHouse();
      const q = await getReviewQueue(pool, { limit: 200 });
      expect(q.items.length).toBeGreaterThan(0);
      for (const it of q.items) {
        expect(it.createdAt, it.key).toBeTypeOf("string");
        expect(it.updatedAt, it.key).toBeTypeOf("string");
        expect(Number.isNaN(new Date(it.updatedAt).getTime()), it.key).toBe(false);
        expect(JSON.stringify(q)).not.toContain("T00:00:00.000+");
      }
    } finally {
      await cleanup();
    }
  });
});

describe("read-only projection, delegation, partial failure", () => {
  it("performs no writes at all (audit-log invariance)", async () => {
    const c = await pool.connect();
    try {
      await mkFullHouse();
      const before = await c.query("select count(*)::int as n from public.audit_log");
      await getReviewQueue(pool, { limit: 200 });
      await getReviewQueue(pool, { domain: "brief", q: "t", limit: 5, offset: 1 });
      await getReviewQueue(pool, { priority: "high", company: "house" });
      const after = await c.query("select count(*)::int as n from public.audit_log");
      expect(after.rows[0].n, "reads must never write").toBe(before.rows[0].n);
    } finally {
      c.release();
      await cleanup();
    }
  });

  it("returns a partial result naming the unreadable source instead of failing", async () => {
    const res = await getReviewQueue(
      pool,
      { limit: 50 },
      [
        { domain: "brief", run: async () => [] },
        {
          domain: "gates",
          run: async () => {
            throw new Error("simulated source outage: secret detail must not leak");
          },
        },
      ],
    );
    expect(res.partial).toBe(true);
    expect(res.failedSources).toEqual(["gates"]);
    expect(JSON.stringify(res)).not.toContain("secret detail");
    expect(res.items.every((i) => i.domain === "brief")).toBe(true);
  });

  it("declares one source per declared domain and keeps them distinct", async () => {
    expect(QUEUE_PARTS.map((p) => p.domain).sort()).toEqual([...QUEUE_DOMAINS].sort());
    expect(new Set(QUEUE_PARTS.map((p) => p.domain)).size).toBe(QUEUE_DOMAINS.length);
  });

  it("tolerates concurrent domain updates while the queue is read", async () => {
    try {
      const h = await mkFullHouse();
      const [a, b, d] = await Promise.all([
        getReviewQueue(pool, { limit: 200 }),
        decideHypothesis(pool, h.portalHyp, { decision: "defer", reason: "t12 concurrent", actor: ACTOR }),
        mkClaim(h.co, "Concurrent intake evidence about the portal"),
      ]);
      expect(b.status).toBe("deferred");
      void d;
      const after = await getReviewQueue(pool, { limit: 200 });
      // Whatever the interleaving, the result is internally consistent.
      expect(new Set(after.items.map((i) => i.key)).size).toBe(after.items.length);
      const ranks = after.items.map((i) => rank(i.priority));
      expect([...ranks].sort((x, y) => x - y)).toEqual(ranks);
      const deferred = after.items.find((i) => i.recordId === h.portalHyp && i.domain === "hypothesis");
      expect(deferred?.status).toBe("deferred");
      expect(deferred?.priority, "an operator-deferred item is informational, not urgent").toBe("informational");
      expect(a.partial).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("ignores records whose underlying domain row is gone (no orphans)", async () => {
    try {
      const co = await mkCo("T12 Orphan Co");
      await mkClaim(co, "Orphaning onboarding announcement");
      const gen = await generateHypotheses(pool, co, ACTOR);
      const hyp = gen.hypotheses[0].id;
      const before = await getReviewQueue(pool, { domain: "gates", limit: 200 });
      expect(before.items.some((i) => i.recordId === hyp)).toBe(true);

      const c = await pool.connect();
      try {
        await c.query("delete from public.hypothesis_evidence where hypothesis_id = $1", [hyp]);
        await c.query("delete from public.hypothesis where id = $1", [hyp]);
      } finally {
        c.release();
      }
      const after = await getReviewQueue(pool, { domain: "gates", limit: 200 });
      expect(after.items.some((i) => i.recordId === hyp), "deleted rows never linger").toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("denies the underlying data to an unprivileged role (no aggregate leak)", async () => {
    const denied = new Pool({ connectionString: NOACCESS_URL, max: 1 });
    try {
      await expect(denied.query("select count(*) from public.match_candidate")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(denied.query("select count(*) from public.brief")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await denied.end();
    }
  });

  it("exposes no mutating queue endpoint and keeps the no-send boundary", () => {
    const src = readFileSync(join(process.cwd(), "app", "review", "page.tsx"), "utf8");
    // No form posts to a queue route: every transition belongs to a domain API.
    expect(src).not.toMatch(/method="post"/i);
    expect(src).not.toMatch(/use server/i);
    const lib = readFileSync(join(process.cwd(), "lib", "review", "queue.ts"), "utf8");
    for (const forbidden of ["insert into", "update ", "delete from"]) {
      expect(lib.toLowerCase(), `queue lib must not contain ${forbidden}`).not.toContain(forbidden);
    }
    // Nothing in the queue module can transmit anything.
    expect(lib.toLowerCase()).not.toContain("fetch(");
  });
});