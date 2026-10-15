/**
 * Part 1 §7/§8/§9: reconciliation, backfill, replay, idempotency — and proof
 * that all of it is manual-only.
 *
 * The three operations stay distinct and operator-invoked:
 *   consume  — claim + apply one batch (nothing automatic calls it);
 *   backfill — cases for view rows that have none (pre-outbox history and
 *              undelivered rows converge here; re-running is a no-op);
 *   reconcile— compare every case with the current view: flag drift, report
 *              orphaned cases. Drift is never auto-cleared.
 * Replay reconstructs from retained snapshots + payloads (read-only).
 *
 * Idempotency: `withIdempotency` runs the function once per key inside a
 * transaction — a repeated key returns the stored result, a reused key with a
 * different request is refused, and a throwing function stores nothing and
 * leaves no partial writes.
 *
 * Manual-only is asserted structurally: no scheduler primitives exist in the
 * qualification lib or the operator script.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { registerOpportunity, transitionOpportunity } from "../lib/discovery/opportunities";
import { getCase, recordAssessment, recordSnapshot, registerReferenceVersion, setCaseStatus, setReferenceStatus, withIdempotency } from "../lib/qualification/cases";
import { readQualificationRow } from "../lib/qualification/view";
import {
  backfillCases,
  consumePendingEvents,
  reconcileAll,
  reconcileCases,
  replayCase,
} from "../lib/qualification/reconcile";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 6 });
const ACTOR = "p1r";
const CONSUMER = `p1r-consumer-${Date.now()}`;

async function cleanup(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("delete from p2.event_inbox where consumer_name = $1", [CONSUMER]);
    await c.query("delete from p2.consumer_watermark where consumer_name = $1", [CONSUMER]);
    await c.query("delete from p2.idempotency_record where scope = 'p1r'");
    // Reference rows are test-global (registration is do-nothing on conflict),
    // so version state must be reset per test.
    await c.query("delete from p2.reference_version where version like 'p1r-%'");
    await c.query("delete from p2.case where discovery_opportunity_key like '%p1r-%'");
    await c.query("delete from public.opportunity where opportunity_key like '%p1r-%'");
    await c.query(
      "update public.company set merged_into = null where domain_norm like 'p1r-%' and merged_into is not null",
    );
    await c.query("delete from public.company where domain_norm like 'p1r-%'");
  } finally {
    c.release();
  }
}

async function seedOpportunity(tag: string): Promise<{ opportunityId: string; key: string }> {
  const stamp = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const co = await createCompany(
    pool,
    {
      name: `P1r ${tag} Co`,
      domain: `p1r-${stamp}.example`,
      agencyType: "web_development",
      country: "United States",
    },
    ACTOR,
  );
  const o = await registerOpportunity(pool, {
    pipeline: "agency_partner",
    sourceKey: "agency-directory",
    sourceRecordId: `P1R-${stamp}`,
    companyId: co.companyId,
    actor: ACTOR,
  });
  return { opportunityId: o.id, key: o.key };
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("P1-8: consume applies events into cases", () => {
  it("creates the case, snapshots the row, and reports honestly", async () => {
    try {
      const s = await seedOpportunity("consume");
      const report = await consumePendingEvents(pool, CONSUMER, ACTOR, 50);
      expect(report.claimed).toBeGreaterThanOrEqual(1);
      expect(report.applied).toBe(report.claimed);
      expect(report.rejected).toBe(0);
      expect(report.unsettled).toBe(0);
      const kase = await getCase(pool, s.opportunityId);
      expect(kase).not.toBeNull();
      expect(kase!.discovery_opportunity_key).toBe(s.key);
      expect(kase!.status).toBe("discovered");
      expect(kase!.latest_sequence).toBe(1);
      const snaps = await pool.query("select count(*)::int as n from p2.case_snapshot where case_id = $1", [
        kase!.case_id,
      ]);
      expect(snaps.rows[0].n).toBe(1);
    } finally {
      await cleanup();
    }
  });
});

describe("P1-8: backfill covers pre-outbox history idempotently", () => {
  it("creates cases for rows with no events, and twice is the same as once", async () => {
    try {
      // A legacy row: inserted directly, so no registration event exists.
      const stamp = `legacy-${Date.now()}`;
      const co = await createCompany(
        pool,
        { name: "P1r Legacy Co", domain: `p1r-${stamp}.example`, agencyType: "web_development", country: "United States" },
        ACTOR,
      );
      const legacy = await pool.query(
        `insert into public.opportunity (pipeline, opportunity_key, company_id)
         values ('agency_partner', $1, $2) returning id`,
        [`opp:agency_partner:agency-directory:p1r-${stamp}`, co.companyId],
      );
      const legacyId = legacy.rows[0].id as string;

      const first = await backfillCases(pool, ACTOR);
      expect(first.checked).toBeGreaterThanOrEqual(1);
      expect(first.casesCreated).toBeGreaterThanOrEqual(1);
      const kase = await getCase(pool, legacyId);
      expect(kase).not.toBeNull();

      const snapsBefore = await pool.query(
        "select count(*)::int as n from p2.case_snapshot where case_id = $1",
        [kase!.case_id],
      );
      const second = await backfillCases(pool, ACTOR);
      expect(second.casesCreated).toBe(0);
      const snapsAfter = await pool.query(
        "select count(*)::int as n from p2.case_snapshot where case_id = $1",
        [kase!.case_id],
      );
      expect(snapsAfter.rows[0].n).toBe(snapsBefore.rows[0].n);
    } finally {
      await cleanup();
    }
  });
});

describe("P1-8: reconcile flags drift and reports orphans, never auto-clears", () => {
  it("detects Discovery movement and keeps the flag until a human acts", async () => {
    try {
      const s = await seedOpportunity("drift");
      await backfillCases(pool, ACTOR);
      const clean = await reconcileCases(pool);
      expect(clean.drifted).toBe(0);

      await transitionOpportunity(pool, s.opportunityId, "eligible", { actor: ACTOR, reason: "p1r" });
      const moved = await reconcileCases(pool);
      expect(moved.drifted).toBe(1);
      const kase = await getCase(pool, s.opportunityId);
      expect(kase!.drift_detected_at).not.toBeNull();

      // Reconciling again reports nothing new AND does not clear the flag:
      // clearing drift is a human assessment act, not a sync act.
      const again = await reconcileCases(pool);
      expect(again.drifted).toBe(0);
      expect((await getCase(pool, s.opportunityId))!.drift_detected_at).not.toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("reports a case whose opportunity vanished as orphaned, and keeps the case", async () => {
    try {
      const s = await seedOpportunity("orphan");
      await backfillCases(pool, ACTOR);
      expect(await getCase(pool, s.opportunityId)).not.toBeNull();
      // The opportunity is removed (retention/takedown path cascades).
      await pool.query("delete from public.opportunity where id = $1", [s.opportunityId]);
      const report = await reconcileCases(pool);
      const kase = await pool.query("select case_id from p2.case where discovery_opportunity_id = $1", [
        s.opportunityId,
      ]);
      expect(kase.rows).toHaveLength(1);
      expect(report.orphaned).toContain(kase.rows[0].case_id as string);
    } finally {
      await cleanup();
    }
  });
});

describe("P1-8: replay reconstructs from retained rows only", () => {
  it("lists snapshots and assessments in order without touching the view", async () => {
    try {
      const s = await seedOpportunity("replay");
      await backfillCases(pool, ACTOR);
      const kase = (await getCase(pool, s.opportunityId))!;
      // Move Discovery on so the assessment snapshot differs from the
      // backfill snapshot (identical state would correctly deduplicate).
      await transitionOpportunity(pool, s.opportunityId, "eligible", { actor: ACTOR, reason: "p1r" });
      const row = await readQualificationRow(pool, s.opportunityId);
      await registerReferenceVersion(pool, "rubric", "p1r-rubric-v1", ACTOR);
      await setReferenceStatus(pool, "rubric", "p1r-rubric-v1", "active", ACTOR);
      const snap = await recordSnapshot(pool, kase.case_id, row!, ACTOR, "assessment-input");
      const a1 = await recordAssessment(pool, kase.case_id, {
        rubricVersion: "p1r-rubric-v1",
        assessment: { verdict: "needs_info", why: "p1r" },
        inputSnapshotId: snap.snapshotId,
        actor: ACTOR,
      });
      expect(a1.version).toBe(1);
      const a2 = await recordAssessment(pool, kase.case_id, {
        rubricVersion: "p1r-rubric-v1",
        assessment: { verdict: "needs_info", why: "p1r again" },
        actor: ACTOR,
      });
      expect(a2.version).toBe(2);

      const replay = await replayCase(pool, kase.case_id);
      expect(replay.snapshots.length).toBeGreaterThanOrEqual(2);
      expect(replay.assessments.map((a) => a.version)).toEqual([1, 2]);
      await expect(replayCase(pool, "11111111-2222-4333-8444-555555555555")).rejects.toMatchObject({
        status: 404,
        code: "case_not_found",
      });
    } finally {
      await cleanup();
    }
  });

  it("refuses assessments against unknown or retired references", async () => {
    try {
      const s = await seedOpportunity("refver");
      await backfillCases(pool, ACTOR);
      const kase = (await getCase(pool, s.opportunityId))!;
      await expect(
        recordAssessment(pool, kase.case_id, { rubricVersion: "p1r-ghost", assessment: {}, actor: ACTOR }),
      ).rejects.toMatchObject({ code: "unknown_reference_version" });
      await registerReferenceVersion(pool, "policy", "p1r-pol-v1", ACTOR);
      await setReferenceStatus(pool, "policy", "p1r-pol-v1", "active", ACTOR);
      await setReferenceStatus(pool, "policy", "p1r-pol-v1", "retired", ACTOR);
      await expect(
        recordAssessment(pool, kase.case_id, { policyVersion: "p1r-pol-v1", assessment: {}, actor: ACTOR }),
      ).rejects.toMatchObject({ code: "retired_reference_version" });
      await expect(
        setReferenceStatus(pool, "policy", "p1r-pol-v1", "active", ACTOR),
      ).rejects.toMatchObject({ code: "bad_reference_transition" });
    } finally {
      await cleanup();
    }
  });

  it("case workflow follows its edges and audits every move", async () => {
    try {
      const s = await seedOpportunity("flow");
      await backfillCases(pool, ACTOR);
      const kase = (await getCase(pool, s.opportunityId))!;
      await expect(setCaseStatus(pool, kase.case_id, "assessed", ACTOR)).rejects.toMatchObject({
        code: "bad_case_transition",
      });
      const moved = await setCaseStatus(pool, kase.case_id, "assessing", ACTOR);
      expect(moved.status).toBe("assessing");
      const done = await setCaseStatus(pool, kase.case_id, "assessed", ACTOR);
      expect(done.status).toBe("assessed");
      const audits = await pool.query(
        "select count(*)::int as n from p2.audit_event where entity_type = 'case' and entity_id = $1 and action like 'status_%'",
        [kase.case_id],
      );
      expect(audits.rows[0].n).toBe(2);
    } finally {
      await cleanup();
    }
  });
});

describe("P1-8: idempotency is transactional", () => {
  it("replays the stored result, refuses key reuse, rolls back on failure", async () => {
    const key = `run-${Date.now()}`;
    let runs = 0;
    const first = await withIdempotency(pool, "p1r", key, { n: 1 }, async (c) => {
      runs += 1;
      await c.query("insert into p2.audit_event (entity_type, entity_id, action, actor) values ('p1r', $1, 'run', 'p1r')", [
        key,
      ]);
      return { total: 42 };
    });
    expect(first).toMatchObject({ replayed: false });
    expect(first.result).toEqual({ total: 42 });
    const second = await withIdempotency(pool, "p1r", key, { n: 1 }, async () => {
      runs += 1;
      return { total: -1 };
    });
    expect(second).toMatchObject({ replayed: true });
    expect(second.result).toEqual({ total: 42 });
    expect(runs).toBe(1);
    await expect(
      withIdempotency(pool, "p1r", key, { n: 2 }, async () => ({ total: 0 })),
    ).rejects.toMatchObject({ code: "idempotency_key_reuse" });

    // A throwing function stores nothing and leaves no partial writes.
    await expect(
      withIdempotency(pool, "p1r", `fail-${Date.now()}`, { n: 1 }, async (c) => {
        await c.query("insert into p2.audit_event (entity_type, entity_id, action, actor) values ('p1r', 'boom', 'run', 'p1r')");
        throw new Error("mid-write failure");
      }),
    ).rejects.toThrow(/mid-write failure/);
    const residue = await pool.query(
      "select count(*)::int as n from p2.audit_event where entity_type = 'p1r' and entity_id = 'boom'",
    );
    expect(residue.rows[0].n).toBe(0);
    await pool.query("delete from p2.audit_event where entity_type = 'p1r'");
  });
});

describe("P1-9: everything here is manual-only", () => {
  it("no scheduler primitives exist in the qualification lib or operator script", () => {
    const ROOT = join(process.cwd());
    const hits: string[] = [];
    const scan = (dir: string) => {
      for (const e of require("fs").readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) scan(p);
        else if (e.name.endsWith(".ts")) {
          const text = readFileSync(p, "utf8");
          for (const m of text.matchAll(/setInterval|setTimeout|node-cron|cron\.schedule|node-schedule|setImmediate/g)) {
            hits.push(`${p}:${m[0]}`);
          }
        }
      }
    };
    scan(join(ROOT, "lib", "qualification"));
    const script = readFileSync(join(ROOT, "scripts", "qualify.mjs"), "utf8");
    for (const m of script.matchAll(/setInterval|setTimeout|node-cron|cron\.schedule|node-schedule|setImmediate/g)) {
      hits.push(`scripts/qualify.mjs:${m[0]}`);
    }
    expect(hits).toEqual([]);
  });
});

describe("P1-8: reconcileAll composes the three steps", () => {
  it("consume, backfill and reconcile run in order under one key", async () => {
    try {
      const s = await seedOpportunity("all");
      const report = await reconcileAll(pool, {
        consumer: CONSUMER,
        actor: ACTOR,
        idempotencyKey: `all-${Date.now()}`,
      });
      expect(report.consume.applied).toBeGreaterThanOrEqual(1);
      expect(report.backfill.checked).toBeGreaterThanOrEqual(1);
      expect(report.reconcile.casesChecked).toBeGreaterThanOrEqual(1);
      expect(await getCase(pool, s.opportunityId)).not.toBeNull();
    } finally {
      await cleanup();
    }
  });
});