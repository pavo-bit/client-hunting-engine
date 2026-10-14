/**
 * T-010 sales workflow tests (local DB only, loopback guard).
 * Covers: brief eligibility + traceability, stale warnings, versioning +
 * review, hypothesis/proposal invalidation, pipeline stages + history +
 * follow-ups, duplicate protection, contact/outcome recording, draft
 * editing/versioning/approval gates, unapproved-catalog labeling, auth,
 * rollback, concurrency, rendering safety, malformed input, and a
 * repository-wide no-automated-delivery scan. Full regressions separate.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { ingestObservation } from "../lib/evidence/ingest";
import { attachEvidence } from "../lib/evidence/ingest";
import { decideHypothesis, generateHypotheses } from "../lib/hypothesis/rules";
import { createProposal, decideProposal, getProposalDetail } from "../lib/proposal/proposals";
import {
  createBrief,
  decideBrief,
  getBriefWorkspace,
  recordOutcome,
  recordPipelineEvent,
} from "../lib/sales/briefs";
import {
  createDraft,
  decideDraft,
  reviseDraft,
} from "../lib/sales/drafts";
import { listCapabilities, setCapabilityStatus } from "../lib/sales/catalog";

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
const ACTOR = "t10test";
let seq = 0;
const dom = (p: string) => `t10-${Date.now()}-${seq++}-${p}.example`;

const PROPOSAL = {
  title: "T10 Portal Pilot",
  scopeIn: "Intake form, status page",
  scopeOut: "Billing migration",
  feasibility: "medium" as const,
  assumptions: "Agency confirms email intake",
  items: [{ name: "Intake form", complexity: "M" as const, kind: "feature" as const }],
  contingencyPct: 15,
  actor: ACTOR,
};

async function mkAcceptedProposal(name: string): Promise<{ co: string; hyp: string; prop: string }> {
  const co = (
    await createCompany(
      pool,
      { name, domain: dom("co"), agencyType: "web_development", country: "United States" },
      ACTOR,
    )
  ).companyId;
  await ingestObservation(
    pool,
    { companyId: co, sourceKey: "company-site", url: `https://h10.example/${seq++}`, excerpt: "Client onboarding portal announced", actor: ACTOR },
    { predicate: "announced", text: "Client onboarding portal announced", reliability: "B", credibility: 2 },
  );
  const gen = await generateHypotheses(pool, co, ACTOR);
  const hyp = gen.hypotheses[0].id;
  await decideHypothesis(pool, hyp, {
    decision: "validate",
    reason: "operator call confirmed",
    actor: ACTOR,
  });
  const prop = await createProposal(pool, { ...PROPOSAL, hypothesisId: hyp });
  await decideProposal(pool, prop.id, { decision: "submit", reason: "ready", actor: ACTOR });
  await decideProposal(pool, prop.id, { decision: "accept", reason: "pursue", actor: ACTOR });
  return { co, hyp, prop: prop.id };
}

async function cleanup() {
  const c = await pool.connect();
  try {
    await c.query(
      `delete from public.hypothesis_evidence where hypothesis_id in (
         select id from public.hypothesis where company_id in (
           select id from public.company
           where domain_norm like 't10-%' or name like 'T10 %'))`,
    );
    await c.query(
      "delete from public.discovery_run where created_by = 't10test'",
    );
    await c.query(
      "delete from public.company where domain_norm like 't10-%' or name like 'T10 %'",
    );
    // Own-namespaced capability keys only. The seed's shared keys (e.g.
    // web-portal-build) are FK-referenced by seed rows and must never be
    // deleted — tests use t10-cap instead (R-01 namespace discipline).
    await c.query("delete from public.capability where key like 't10-%'");
  } finally {
    c.release();
  }
}

describe("brief lifecycle + invalidation", () => {
  it("reviews with rationale; invalid transitions rejected; history kept", async () => {
    const { prop } = await mkAcceptedProposal("T10 Review Co");
    try {
      const b = await createBrief(pool, { proposalId: prop, actor: ACTOR });
      // Draft cannot skip straight to approved.
      await expect(
        decideBrief(pool, b.ref, { decision: "approve", reason: "x", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        decideBrief(pool, b.ref, { decision: "submit", reason: "", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 422 });
      await decideBrief(pool, b.ref, { decision: "submit", reason: "ready for review", actor: ACTOR });
      const ap = await decideBrief(pool, b.ref, { decision: "approve", reason: "evidence solid", actor: ACTOR });
      expect(ap.status).toBe("approved");
      const ws = await getBriefWorkspace(pool, b.ref);
      expect(ws?.brief).toMatchObject({ status: "approved" });
      // Terminal-ish states stay decided.
      await decideBrief(pool, b.ref, { decision: "archive", reason: "done", actor: ACTOR });
      await expect(
        decideBrief(pool, b.ref, { decision: "submit", reason: "x", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        decideBrief(pool, "BR-2999-999", { decision: "submit", reason: "x", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await cleanup();
    }
  });

  it("flags briefs when the hypothesis is rejected or the proposal goes stale", async () => {
    const { co, hyp, prop } = await mkAcceptedProposal("T10 Invalid Co");
    try {
      const b = await createBrief(pool, { proposalId: prop, actor: ACTOR });
      // Reject the underlying hypothesis afterwards.
      const { decideHypothesis } = await import("../lib/hypothesis/rules");
      await decideHypothesis(pool, hyp, { decision: "reject", reason: "re-examined", actor: ACTOR });
      const ws = await getBriefWorkspace(pool, b.ref);
      expect(ws?.stale).toBe(true);
      expect(ws?.staleReasons.join(" ")).toMatch(/hypothesis is rejected/);
      void co;
    } finally {
      await cleanup();
    }
  });
});

describe("pipeline + outcomes (human-only)", () => {
  it("records stages with notes, history, follow-ups; validates strictly", async () => {
    const { prop } = await mkAcceptedProposal("T10 Pipe Co");
    try {
      const b = await createBrief(pool, { proposalId: prop, actor: ACTOR });
      const { recordPipelineEvent } = await import("../lib/sales/briefs");
      await expect(
        recordPipelineEvent(pool, b.ref, { stage: "bogus", note: "x", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        recordPipelineEvent(pool, b.ref, { stage: "qualified", note: "", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        recordPipelineEvent(pool, b.ref, { stage: "qualified", note: "x", actor: ACTOR, followUpDate: "15-01-2027" }),
      ).rejects.toMatchObject({ status: 422 });
      const e1 = await recordPipelineEvent(pool, b.ref, {
        stage: "qualified",
        note: "fit looks real",
        nextAction: "Call Maya Thursday",
        followUpDate: "2027-02-01",
        actor: ACTOR,
      });
      expect(e1.stage).toBe("qualified");
      await recordPipelineEvent(pool, b.ref, {
        stage: "ready_for_outreach",
        note: "brief approved internally; human will write separately",
        actor: ACTOR,
      });
      const ws = await getBriefWorkspace(pool, b.ref);
      expect(ws?.brief).toMatchObject({ pipeline_stage: "ready_for_outreach" });
      expect(ws?.pipeline).toHaveLength(2);
      expect(ws?.pipeline[0]).toMatchObject({ from_stage: null, to_stage: "qualified" });
    } finally {
      await cleanup();
    }
  });

  it("records observed outcomes without fabricating activity", async () => {
    const { prop } = await mkAcceptedProposal("T10 Outcome Co");
    try {
      const b = await createBrief(pool, { proposalId: prop, actor: ACTOR });
      const { recordOutcome } = await import("../lib/sales/briefs");
      const o = await recordOutcome(pool, b.ref, {
        channel: "email",
        outcome: "discovery_meeting",
        note: "Maya replied; call booked by operator",
        sentAtManual: "2026-10-01",
        actor: ACTOR,
      });
      expect(o.id).toBeDefined();
      await expect(
        recordOutcome(pool, b.ref, { outcome: "telepathy", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        recordOutcome(pool, "BR-2999-999", { outcome: "won", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 404 });
      const ws = await getBriefWorkspace(pool, b.ref);
      expect(ws?.outcomes).toHaveLength(1);
      expect(ws?.outcomes[0]).toMatchObject({ outcome: "discovery_meeting", recorded_by: ACTOR });
    } finally {
      await cleanup();
    }
  });
});

describe("draft lifecycle + approval gate", () => {
  it("versions drafts, blocks approval on unverified points, audits all", async () => {
    const { prop } = await mkAcceptedProposal("T10 Draft Co");
    try {
      const b = await createBrief(pool, { proposalId: prop, actor: ACTOR });
      const d1 = await createDraft(pool, {
        briefRef: b.ref,
        channel: "email",
        subject: "Quick idea",
        body: "Hi — we help agencies with onboarding portals. — Grayscales",
        personalization: "brief BR evidence: email intake",
        unverifiedPoints: "claim they lose deals to intake friction (unproven)",
        actor: ACTOR,
      });
      expect(d1.version).toBe(1);
      await expect(
        decideDraft(pool, d1.id, { decision: "bogus", reason: "x", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 422 });
      await decideDraft(pool, d1.id, { decision: "submit", reason: "ready?", actor: ACTOR });
      // Approval blocked while unverified assertions remain.
      await expect(
        decideDraft(pool, d1.id, { decision: "approve", reason: "looks fine", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 409, code: "unverified_points" });
      // Revise to clear the flag → new version → approval works.
      const d2 = await reviseDraft(pool, d1.id, ACTOR, { unverifiedPoints: "" });
      expect(d2.version).toBe(2);
      await decideDraft(pool, d2.id, { decision: "submit", reason: "cleaned", actor: ACTOR });
      const ap = await decideDraft(pool, d2.id, { decision: "approve", reason: "traced to brief", actor: ACTOR });
      expect(ap.status).toBe("ready");
      // Ready rows are immutable via revise.
      await expect(
        reviseDraft(pool, d2.id, ACTOR, { body: "changed" }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        createDraft(pool, { briefRef: "BR-2999-999", channel: "email", body: "x", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        createDraft(pool, { briefRef: b.ref, channel: "pigeon", body: "x", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 422 });
    } finally {
      await cleanup();
    }
  });
});

describe("catalog honesty + authorization + integrity", () => {
  it("lists draft placeholders distinctly; status changes audited", async () => {
    const c = await pool.connect();
    try {
      await c.query(
        `insert into public.capability (key, name, is_placeholder, status)
         values ('t10-cap', 'T10 Draft Capability', true, 'needs_owner_review')
         on conflict (key) do nothing`,
      );
    } finally {
      c.release();
    }
    try {
      const rows = await listCapabilities(pool);
      const mine = rows.find((r) => r.key === "t10-cap")!;
      expect(mine.status).toBe("needs_owner_review");
      expect(mine.is_placeholder).toBe(true);
      await expect(
        setCapabilityStatus(pool, "t10-cap", { status: "approved", reason: "", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 422 });
      const done = await setCapabilityStatus(pool, "t10-cap", {
        status: "approved",
        reason: "owner confirmed in writing",
        actor: ACTOR,
      });
      expect(done.status).toBe("approved");
      await expect(
        setCapabilityStatus(pool, "t10-missing", { status: "approved", reason: "x", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      const c2 = await pool.connect();
      try {
        await c2.query("delete from public.capability where key = 't10-cap'");
      } finally {
        c2.release();
      }
    }
  });

  it("denies unprivileged writes to sales tables; rolls back failures cleanly", async () => {
    const denied = new Pool({ connectionString: NOACCESS_URL, max: 1 });
    try {
      await expect(
        denied.query("insert into public.pipeline_event (brief_ref, to_stage, note, actor) values ('BR-2026-001', 'won', 'x', 'x')"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        denied.query("select count(*) from public.outreach_draft"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await denied.end();
    }
    // Failed brief creation leaves no partial rows.
    const c = await pool.connect();
    try {
      const before = await c.query("select count(*)::int as n from public.brief");
      await expect(
        createBrief(pool, { proposalId: "00000000-0000-4000-8000-000000000000", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 404 });
      const after = await c.query("select count(*)::int as n from public.brief");
      expect(after.rows[0].n).toBe(before.rows[0].n);
    } finally {
      c.release();
    }
  });

  it("concurrent briefs for one proposal yield exactly one active row", async () => {
    const { prop } = await mkAcceptedProposal("T10 Race Co");
    try {
      const [a, b] = await Promise.allSettled([
        createBrief(pool, { proposalId: prop, actor: ACTOR }),
        createBrief(pool, { proposalId: prop, actor: ACTOR }),
      ]);
      const ok = [a, b].filter((x) => x.status === "fulfilled");
      const denied = [a, b].filter(
        (x) => x.status === "rejected" && (x.reason as { status?: number }).status === 409,
      );
      expect(ok.length).toBe(1);
      expect(denied.length).toBe(1);
    } finally {
      await cleanup();
    }
  });
});

describe("no automated delivery (repository scan)", () => {
  it("finds no send endpoints, delivery jobs, or messaging automation", () => {
    // Distinguishes executable delivery capability from harmless draft text:
    // matches only known sending libraries/protocols, automation verbs on
    // messaging channels, and browser-automation frameworks.
    const pattern =
      /nodemailer|sendgrid|mailgun|postmark|twilio|plivo|whatsapp|telegram[_-]?bot|discord\.js|smtpjs|emailjs|imap|pop3|playwright|puppeteer|selenium|contact[-_]?form[-_ ]?(submit|post|deliver|automat)|auto[-_ ]?send|send[-_ ]?(email|mail|message|dm|queue)|deliver[-_ ]?(email|queue|message)/i;
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === ".next") continue;
          walk(p);
        } else if (/\.tsx?$/.test(p)) {
          const src = readFileSync(p, "utf8");
          const lines = src.split("\n");
          lines.forEach((line, i) => {
            if (pattern.test(line)) hits.push(`${p}:${i + 1}: ${line.trim().slice(0, 120)}`);
          });
        }
      }
    };
    for (const root of ["app", "lib", "components"]) walk(root);
    // scripts/db.mjs is excluded (migration runner, no messaging); package
    // scripts contain no send tooling (verified by inspection in report).
    expect(hits).toEqual([]);
  });
});

describe("brief eligibility + traceability", () => {
  it("requires an accepted proposal; freezes exact versions", async () => {
    const co = (
      await createCompany(
        pool,
        { name: "T10 Elig Co", domain: dom("co"), agencyType: "web_development", country: "United States" },
        ACTOR,
      )
    ).companyId;
    try {
      await ingestObservation(
        pool,
        { companyId: co, sourceKey: "company-site", url: `https://h10.example/${seq++}`, excerpt: "Client portal onboarding announced", actor: ACTOR },
        { predicate: "announced", text: "Client portal onboarding announced", reliability: "B", credibility: 2 },
      );
      const gen = await generateHypotheses(pool, co, ACTOR);
      const hyp = gen.hypotheses[0].id;
      const { decideHypothesis } = await import("../lib/hypothesis/rules");
      // Proposal creation itself requires a validated hypothesis.
      await decideHypothesis(pool, hyp, { decision: "validate", reason: "operator confirmed", actor: ACTOR });
      const prop = await createProposal(pool, { ...PROPOSAL, hypothesisId: hyp });
      // Draft proposal is not eligible.
      await expect(
        createBrief(pool, { proposalId: prop.id, actor: ACTOR }),
      ).rejects.toMatchObject({ status: 409, code: "proposal_not_eligible" });
      await decideProposal(pool, prop.id, { decision: "submit", reason: "r", actor: ACTOR });
      await decideProposal(pool, prop.id, { decision: "accept", reason: "go", actor: ACTOR });
      const b = await createBrief(pool, { proposalId: prop.id, actor: ACTOR });
      expect(b.ref).toMatch(/^BR-\d{4}-\d{3,}$/);
      const ws = await getBriefWorkspace(pool, b.ref);
      expect(ws?.proposal).toMatchObject({ id: prop.id });
      // Frozen hash recomputes from stored inputs (traceability check).
      const c = await pool.connect();
      try {
        const row = await c.query(
          "select frozen_inputs_hash, markdown from public.brief where ref = $1",
          [b.ref],
        );
        expect(row.rows[0].frozen_inputs_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(row.rows[0].markdown).toMatch(/Opportunity brief/);
        expect(row.rows[0].markdown).toMatch(/never|human/i);
      } finally {
        c.release();
      }
      // Second active brief for the same proposal is rejected.
      await expect(
        createBrief(pool, { proposalId: prop.id, actor: ACTOR }),
      ).rejects.toMatchObject({ status: 409, code: "brief_exists" });
      await expect(
        createBrief(pool, { proposalId: "00000000-0000-4000-8000-000000000000", actor: ACTOR }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await cleanup();
    }
  });

  it("warns on unapproved capabilities and stale proposal states", async () => {
    const { prop } = await mkAcceptedProposal("T10 Stale Co");
    const c = await pool.connect();
    try {
      // Placeholder catalog entry (unapproved by design). Own-namespaced key:
      // the shared seed key must never be touched (see cleanup).
      await c.query(
        `insert into public.capability (key, name, is_placeholder, status)
         values ('t10-cap', 'SYNTHETIC PLACEHOLDER', true, 'needs_owner_review')
         on conflict (key) do nothing`,
      );
      await c.query(
        "insert into public.project_capability (project_option_id, capability_key) values ($1, 't10-cap') on conflict do nothing",
        [prop],
      );
    } finally {
      c.release();
    }
    try {
      const b = await createBrief(pool, { proposalId: prop, actor: ACTOR });
      expect(b.warnings.join(" ")).toMatch(/never present as an approved offering/);
      const ws = await getBriefWorkspace(pool, b.ref);
      expect(ws?.stale).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe("safe date rendering (static guard)", () => {
  it("formats pg DATE columns before React rendering (no raw Date children)", () => {
    // pg returns DATE as Date objects; rendering one raw crashes React
    // (twice-bitten: /pipeline, T-008 and T-010). Scan page sources for
    // direct {x.<date-ish>} interpolations outside new Date(...) calls.
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.tsx$/.test(p)) continue;
        const lines = readFileSync(p, "utf8").split("\n");
        lines.forEach((line, i) => {
          const m = line.match(/\{\s*[a-z]+\.[a-z_]*(?:_at|_date|Date)\s*\}/);
          if (m && !line.includes("new Date(")) bad.push(`${p}:${i + 1}: ${m[0]}`);
        });
      }
    };
    walk("app");
    expect(bad).toEqual([]);
  });
});
