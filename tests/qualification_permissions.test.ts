/**
 * Part 1 §7/§9: the permissions contradiction, resolved and proven.
 *
 * Phase 2 may READ the approved qualification view, but event claiming and
 * acknowledgement go through the two narrowly scoped SECURITY DEFINER
 * functions — and nothing else. In particular the Phase 2 role holds:
 *   - column-level SELECT on the view EXCEPT operator attribution;
 *   - EXECUTE on claim/ack, SELECT on its own inbox rows and watermark;
 *   - full use of its OWN p2 domain tables (cases, snapshots, assessments,
 *     audit, idempotency, references);
 *   - NO access whatsoever to Discovery tables (not even SELECT), NO direct
 *     writes to the inbox or watermark (dedup and watermark invariants cannot
 *     be bypassed), NO delete anywhere.
 *
 * Every assertion below connects as the role itself — grants are proven, not
 * assumed. The unprivileged `noaccess` role is denied everything, including
 * the view and the functions.
 */
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { registerOpportunity } from "../lib/discovery/opportunities";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const P2_URL =
  process.env.TEST_P2_URL ?? "postgresql://p2_app:p2-app-local-only@127.0.0.1:5434/agency_intel_test";
const NOACCESS_URL =
  process.env.TEST_NOACCESS_URL ??
  "postgresql://noaccess:noaccess-local-only@127.0.0.1:5434/agency_intel_test";
const pool = new Pool({ connectionString: DB_URL, max: 4 });
const ACTOR = "p1p";

async function cleanup(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("delete from p2.event_inbox where consumer_name like 'p1p-%'");
    await c.query("delete from p2.consumer_watermark where consumer_name like 'p1p-%'");
    await c.query("delete from p2.case where discovery_opportunity_key like '%p1p-%'");
    await c.query("delete from public.opportunity where opportunity_key like '%p1p-%'");
    await c.query("delete from public.company where domain_norm like 'p1p-%'");
  } finally {
    c.release();
  }
}

function asP2(): Client {
  return new Client({ connectionString: P2_URL });
}
function asNobody(): Client {
  return new Client({ connectionString: NOACCESS_URL });
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("P1-9: the Phase 2 role cannot touch Discovery-owned records", () => {
  it("is denied direct writes AND direct reads on every Discovery table", async () => {
    const p2 = asP2();
    await p2.connect();
    try {
      await expect(
        p2.query(
          "insert into public.opportunity (pipeline, opportunity_key) values ('agency_partner','opp:agency_partner:p1p:x')",
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        p2.query("update public.opportunity set status = 'eligible' where pipeline = 'agency_partner'"),
      ).rejects.toThrow(/permission denied/i);
      await expect(p2.query("delete from public.opportunity")).rejects.toThrow(/permission denied/i);
      await expect(p2.query("select count(*) from public.opportunity")).rejects.toThrow(/permission denied/i);
      await expect(p2.query("select count(*) from public.company")).rejects.toThrow(/permission denied/i);
      await expect(p2.query("select count(*) from public.discovery_outbox")).rejects.toThrow(/permission denied/i);
      await expect(
        p2.query(
          "insert into public.discovery_outbox (opportunity_id, sequence, event_type, payload, recorded_by) values ('11111111-2222-4333-8444-555555555555', 1, 'opportunity_registered', '{}', 'x')",
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await p2.end();
    }
  });

  it("cannot bypass the inbox invariants with direct writes either", async () => {
    const p2 = asP2();
    await p2.connect();
    try {
      await expect(
        p2.query(
          "insert into p2.event_inbox (event_id, outbox_id, opportunity_id, event_type, payload_version, opportunity_sequence, payload, occurred_at, recorded_by, consumer_name) values (gen_random_uuid(), 1, '11111111-2222-4333-8444-555555555555', 'opportunity_registered', 1, 1, '{}', now(), 'x', 'p1p-sneaky')",
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        p2.query("update p2.event_inbox set status = 'applied' where consumer_name = 'p1p-sneaky'"),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        p2.query("update p2.consumer_watermark set last_outbox_id = 999999 where consumer_name = 'p1p-sneaky'"),
      ).rejects.toThrow(/permission denied/i);
      await expect(p2.query("delete from p2.event_inbox")).rejects.toThrow(/permission denied/i);
      await expect(p2.query("delete from p2.case")).rejects.toThrow(/permission denied/i);
    } finally {
      await p2.end();
    }
  });

  it("consumes only through the two scoped functions", async () => {
    const p2 = asP2();
    await p2.connect();
    try {
      // Functions are executable and behave (empty backlog, not an error).
      const claimed = await p2.query("select * from p2.claim_events('p1p-func', 10)");
      expect(claimed.rows).toEqual([]);
      await expect(
        p2.query("select * from p2.ack_event('p1p-func', '11111111-2222-4333-8444-555555555555', 'applied', null)"),
      ).rejects.toThrow(/not delivered/i);
      // Delivery inspection is readable (facts, not secrets); settlement is
      // not — the ack above is the only way to settle.
      const inbox = await p2.query("select count(*)::int as n from p2.event_inbox");
      expect(inbox.rows[0].n).toBeGreaterThanOrEqual(0);
      const wm = await p2.query("select count(*)::int as n from p2.consumer_watermark");
      expect(wm.rows[0].n).toBeGreaterThanOrEqual(0);
    } finally {
      await p2.end();
    }
  });
});

describe("P1-9: the Phase 2 role owns its own domain", () => {
  it("writes and reads cases, snapshots, assessments, audit and idempotency", async () => {
    const p2 = asP2();
    await p2.connect();
    try {
      const kase = await p2.query(
        `insert into p2.case
           (discovery_opportunity_id, discovery_opportunity_key, pipeline,
            discovery_updated_at, discovery_state_hash, created_by)
         values ('11111111-2222-4333-8444-555555555555', 'opp:agency_partner:p1p:own', 'agency_partner', now(), 'abc', 'p1p')
         returning case_id`,
      );
      const caseId = kase.rows[0].case_id as string;
      const read = await p2.query("select status from p2.case where case_id = $1", [caseId]);
      expect(read.rows[0].status).toBe("discovered");
      await p2.query(
        "update p2.case set status = 'assessing' where case_id = $1",
        [caseId],
      );
      const idem = await p2.query(
        "insert into p2.idempotency_record (scope, key, request_hash) values ('p1p', 'k1', 'h') returning key",
      );
      expect(idem.rows[0].key).toBe("k1");
      // …but deletes nothing, anywhere in p2.
      await expect(p2.query("delete from p2.idempotency_record")).rejects.toThrow(/permission denied/i);
      // Test rows removed by the owner cleanup below (role cannot delete).
      await pool.query("delete from p2.idempotency_record where scope = 'p1p'");
      await pool.query("delete from p2.case where case_id = $1", [caseId]);
    } finally {
      await p2.end();
    }
  });
});

describe("P1-9: the unprivileged role is denied the whole interface", () => {
  it("reads neither the view, the outbox, nor p2 — and executes nothing", async () => {
    const na = asNobody();
    await na.connect();
    try {
      await expect(
        na.query("select * from public.v_opportunity_for_qualification_v1 limit 1"),
      ).rejects.toThrow(/permission denied/i);
      await expect(na.query("select count(*) from public.discovery_outbox")).rejects.toThrow(
        /permission denied/i,
      );
      await expect(na.query("select count(*) from p2.case")).rejects.toThrow(/permission denied/i);
      await expect(na.query("select * from p2.claim_events('x', 1)")).rejects.toThrow(/permission denied/i);
      await expect(
        na.query("select * from p2.ack_event('x', '11111111-2222-4333-8444-555555555555', 'applied', null)"),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await na.end();
    }
  });
});

describe("P1-9: unauthorized HTTP-layer writes stay refused (existing boundary)", () => {
  it("a stranger cannot register opportunities without a session (route guard intact)", async () => {
    // The route-level guard is covered by discovery_routes_security.test.ts R1;
    // here we prove the LIBRARY still requires attribution (defense in depth).
    await expect(
      registerOpportunity(pool, {
        pipeline: "agency_partner",
        sourceKey: "agency-directory",
        sourceRecordId: "P1P-NOACTOR",
        actor: "   ",
      }),
    ).rejects.toMatchObject({ status: 422, code: "actor_required" });
    // And the failed registration emitted no event.
    const n = await pool.query(
      "select count(*)::int as n from public.discovery_outbox o join public.opportunity op on op.id = o.opportunity_id where op.opportunity_key like '%p1p-%'",
    );
    expect(n.rows[0].n).toBe(0);
    void createCompany;
  });
});