/**
 * Part 1 §7: durable event consumption over the shared database.
 *
 * No broker exists (and none may be introduced): `public.discovery_outbox` is
 * the queue, `p2.claim_events` / `p2.ack_event` are the only doors, and the
 * watermark only advances across a contiguous settled prefix. These tests pin,
 * deterministically (no sleeps, no timing):
 *   - emission is transactional with the state change (register/transition/
 *     evaluate each append exactly one event, sequences 1..N per opportunity,
 *     global outbox order monotonic);
 *   - duplicate delivery is safe (redelivery reports already_seen, no dup row);
 *   - out-of-order acknowledgement never skips the gap;
 *   - interruption + reclaim converges without loss or duplication;
 *   - poison is retained as a dead letter and counted, never deleted;
 *   - unsupported payload versions are rejected by contract;
 *   - the outbox itself is append-only (UPDATE refused; DELETE only via the
 *     parent opportunity's removal);
 *   - concurrent consumers stay independent and never duplicate inbox rows.
 *
 * Isolated test database; consumers are namespaced per test so watermarks and
 * inbox rows never leak across tests.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import { evaluateEligibility } from "../lib/discovery/eligibility";
import { outboxEventsFor } from "../lib/discovery/events";
import { registerOpportunity, transitionOpportunity } from "../lib/discovery/opportunities";
import {
  ackEvent,
  applyClaimedEvent,
  claimEvents,
  consumerWatermark,
} from "../lib/qualification/events";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 6 });
const ACTOR = "p1e";
const POLICY = { version: "p1e-policy-v1", gates: [{ id: "g", passed: true, reason: "p1e" }] };
let consumerSeq = 0;
const consumer = (tag: string): string => `p1e-${tag}-${Date.now()}-${consumerSeq++}`;

async function cleanup(consumers: string[] = []): Promise<void> {
  const c = await pool.connect();
  try {
    if (consumers.length > 0) {
      await c.query("delete from p2.event_inbox where consumer_name = any($1)", [consumers]);
      await c.query("delete from p2.consumer_watermark where consumer_name = any($1)", [consumers]);
    }
    await c.query("delete from p2.case where discovery_opportunity_key like '%p1e-%'");
    await c.query("delete from public.opportunity where opportunity_key like '%p1e-%'");
    await c.query("delete from public.company where domain_norm like 'p1e-%'");
  } finally {
    c.release();
  }
}

async function seedOpportunity(tag: string): Promise<{ opportunityId: string; key: string }> {
  const stamp = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const co = await createCompany(
    pool,
    {
      name: `P1e ${tag} Co`,
      domain: `p1e-${stamp}.example`,
      agencyType: "web_development",
      country: "United States",
    },
    ACTOR,
  );
  const o = await registerOpportunity(pool, {
    pipeline: "agency_partner",
    sourceKey: "agency-directory",
    sourceRecordId: `P1E-${stamp}`,
    companyId: co.companyId,
    actor: ACTOR,
  });
  return { opportunityId: o.id, key: o.key };
}

beforeAll(() => cleanup());
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("P1-7: emission is transactional with the state change", () => {
  it("register, transition and evaluate append sequences 1, 2, 3 with facts", async () => {
    const con = consumer("emission");
    try {
      const s = await seedOpportunity("emission");
      await transitionOpportunity(pool, s.opportunityId, "eligible", { actor: ACTOR, reason: "p1e" });
      await evaluateEligibility(pool, s.opportunityId, POLICY, { actor: ACTOR });

      const events = await outboxEventsFor(pool, s.opportunityId);
      expect(events.map((e) => e.eventType)).toEqual([
        "opportunity_registered",
        "opportunity_status_changed",
        "eligibility_decided",
      ]);
      expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
      expect(events.every((e) => e.payloadVersion === 1)).toBe(true);
      expect(events.every((e) => e.recordedBy === ACTOR)).toBe(true);
      // Event ids are stable and unique; outbox order is monotonic.
      expect(new Set(events.map((e) => e.eventId)).size).toBe(3);
      expect(events[0].outboxId).toBeLessThan(events[1].outboxId);
      expect(events[1].outboxId).toBeLessThan(events[2].outboxId);
      // Payloads carry facts, and the key is the real source key.
      expect(events[0].payload).toMatchObject({ opportunity_key: s.key, pipeline: "agency_partner" });
      expect(events[1].payload).toMatchObject({ transition_from: "observed", transition_to: "eligible" });
      expect(events[2].payload).toMatchObject({ version: 1, decision: "eligible" });
    } finally {
      await cleanup([con]);
    }
  });

  it("a failed state change appends no event", async () => {
    const con = consumer("noevent");
    try {
      const s = await seedOpportunity("noevent");
      await expect(
        transitionOpportunity(pool, s.opportunityId, "promoted", { actor: ACTOR, reason: "p1e skips eligible" }),
      ).rejects.toMatchObject({ code: "bad_transition" });
      // observed -> promoted is not an allowed edge: nothing changed, nothing emitted.
      const events = await outboxEventsFor(pool, s.opportunityId);
      expect(events.map((e) => e.eventType)).toEqual(["opportunity_registered"]);
      // A re-registration (idempotent conflict path) also emits nothing new.
      const again = await registerOpportunity(pool, {
        pipeline: "agency_partner",
        sourceKey: "agency-directory",
        sourceRecordId: events[0].payload
          ? (events[0].payload as { opportunity_key: string }).opportunity_key.split(":").slice(-1)[0].toUpperCase()
          : "P1E-X",
        actor: ACTOR,
      });
      expect(again.created).toBe(false);
      expect((await outboxEventsFor(pool, s.opportunityId)).length).toBe(1);
    } finally {
      await cleanup([con]);
    }
  });

  it("the outbox is append-only: UPDATE refused, DELETE only via the parent", async () => {
    const con = consumer("appendonly");
    try {
      const s = await seedOpportunity("appendonly");
      await expect(
        pool.query("update public.discovery_outbox set event_type = 'x' where opportunity_id = $1", [s.opportunityId]),
      ).rejects.toThrow(/append-only/i);
      const before = await outboxEventsFor(pool, s.opportunityId);
      expect(before.length).toBe(1);
      // Removing the opportunity cascades its events away (retention/takedown).
      await pool.query("delete from public.opportunity where id = $1", [s.opportunityId]);
      expect(await outboxEventsFor(pool, s.opportunityId)).toEqual([]);
    } finally {
      await cleanup([con]);
    }
  });
});

describe("P1-7: claim, duplicate delivery and interruption", () => {
  it("claims, applies, and advances the watermark exactly once", async () => {
    const con = consumer("claim");
    try {
      const s = await seedOpportunity("claim");
      const claimed = await claimEvents(pool, con, 50);
      expect(claimed.map((e) => e.opportunitySequence)).toEqual([1]);
      expect(claimed[0].alreadySeen).toBe(false);

      const outcome = await applyClaimedEvent(pool, con, claimed[0], ACTOR);
      expect(outcome).toBe("applied");
      const wm = await consumerWatermark(pool, con);
      expect(wm.lastOutboxId).toBe(claimed[0].outboxId);
      expect(wm.appliedCount).toBe(1);

      // Nothing new to claim afterwards.
      expect(await claimEvents(pool, con, 50)).toEqual([]);
      void s;
    } finally {
      await cleanup([con]);
    }
  });

  it("redelivery without acknowledgement reports already_seen and duplicates nothing", async () => {
    const con = consumer("dupe");
    try {
      await seedOpportunity("dupe");
      const first = await claimEvents(pool, con, 50);
      expect(first).toHaveLength(1);
      const second = await claimEvents(pool, con, 50);
      expect(second).toHaveLength(1);
      expect(second[0].alreadySeen).toBe(true);
      expect(second[0].eventId).toBe(first[0].eventId);
      const inbox = await pool.query(
        "select count(*)::int as n from p2.event_inbox where consumer_name = $1",
        [con],
      );
      expect(inbox.rows[0].n).toBe(1);
      // Settle it; the watermark still advances exactly once.
      await ackEvent(pool, con, first[0].eventId, "applied");
      expect((await consumerWatermark(pool, con)).appliedCount).toBe(1);
    } finally {
      await cleanup([con]);
    }
  });

  it("interruption between claim and ack converges on reclaim", async () => {
    const con = consumer("crash");
    try {
      await seedOpportunity("crash");
      const claimed = await claimEvents(pool, con, 50);
      expect(claimed).toHaveLength(1);
      // Simulate the crash: the process dies here holding an unacked claim.
      // A new process claims again and finds the same event waiting.
      const reclaimed = await claimEvents(pool, con, 50);
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0].alreadySeen).toBe(true);
      expect(await applyClaimedEvent(pool, con, reclaimed[0], ACTOR)).toBe("applied");
      const wm = await consumerWatermark(pool, con);
      expect(wm.lastOutboxId).toBe(claimed[0].outboxId);
      const inbox = await pool.query(
        "select count(*)::int as n from p2.event_inbox where consumer_name = $1",
        [con],
      );
      expect(inbox.rows[0].n).toBe(1);
    } finally {
      await cleanup([con]);
    }
  });
});

describe("P1-7: ordering, gaps and poison", () => {
  it("an out-of-order ack never skips the gap", async () => {
    const con = consumer("gap");
    try {
      const s = await seedOpportunity("gap");
      await transitionOpportunity(pool, s.opportunityId, "eligible", { actor: ACTOR, reason: "p1e" });
      const claimed = await claimEvents(pool, con, 50);
      expect(claimed).toHaveLength(2);
      // Settle the SECOND event first: the watermark must stay behind the gap —
      // that is, exactly one position below the still-unsettled first event,
      // not at zero (positions are global stream positions, not per-test).
      const late = await ackEvent(pool, con, claimed[1].eventId, "applied");
      expect(late.lastOutboxId).toBe(claimed[0].outboxId - 1);
      expect(late.unsettled).toBe(1);
      // Settling the first closes the gap and jumps to the contiguous prefix.
      const early = await ackEvent(pool, con, claimed[0].eventId, "applied");
      expect(early.lastOutboxId).toBe(claimed[1].outboxId);
      expect(early.unsettled).toBe(0);
    } finally {
      await cleanup([con]);
    }
  });

  it("re-acking a settled event is a no-op that writes no second audit row", async () => {
    const con = consumer("reack");
    try {
      await seedOpportunity("reack");
      const claimed = await claimEvents(pool, con, 50);
      await ackEvent(pool, con, claimed[0].eventId, "applied");
      const audits = await pool.query(
        "select count(*)::int as n from p2.audit_event where entity_type = 'event' and entity_id = $1",
        [claimed[0].eventId],
      );
      expect(audits.rows[0].n).toBe(1);
      const again = await ackEvent(pool, con, claimed[0].eventId, "applied");
      expect(again.eventStatus).toBe("applied");
      const auditsAfter = await pool.query(
        "select count(*)::int as n from p2.audit_event where entity_type = 'event' and entity_id = $1",
        [claimed[0].eventId],
      );
      expect(auditsAfter.rows[0].n).toBe(1);
    } finally {
      await cleanup([con]);
    }
  });

  it("a poison event is retained as a dead letter, counted, and never deleted", async () => {
    const con = consumer("poison");
    try {
      await seedOpportunity("poison");
      const claimed = await claimEvents(pool, con, 50);
      // The consumer tried its own retries and gives up: explicit dead-letter.
      const dead = await ackEvent(pool, con, claimed[0].eventId, "dead", "payload failed validation 3 times");
      expect(dead.eventStatus).toBe("dead");
      expect(dead.lastOutboxId).toBe(claimed[0].outboxId);
      expect((await consumerWatermark(pool, con)).deadCount).toBe(1);
      const row = await pool.query(
        "select status, last_error from p2.event_inbox where consumer_name = $1",
        [con],
      );
      expect(row.rows[0].status).toBe("dead");
      expect(row.rows[0].last_error).toContain("3 times");
    } finally {
      await cleanup([con]);
    }
  });

  it("an unsupported payload version is rejected by contract, not misapplied", async () => {
    const con = consumer("version");
    try {
      const s = await seedOpportunity("version");
      // A future producer wrote envelope v999: simulate it directly (the
      // append function only ever writes v1, so this path is unreachable
      // through the supported API — which is exactly the point).
      await pool.query(
        `insert into public.discovery_outbox
           (opportunity_id, sequence, event_type, payload_version, payload, recorded_by)
         values ($1, 999, 'opportunity_registered', 999, '{}', $2)`,
        [s.opportunityId, ACTOR],
      );
      const claimed = await claimEvents(pool, con, 50);
      expect(claimed.map((e) => e.payloadVersion).sort()).toEqual([1, 999]);
      const future = claimed.find((e) => e.payloadVersion === 999)!;
      expect(await applyClaimedEvent(pool, con, future, ACTOR)).toBe("rejected");
      const row = await pool.query(
        "select status, last_error from p2.event_inbox where consumer_name = $1 and event_id = $2",
        [con, future.eventId],
      );
      expect(row.rows[0].status).toBe("rejected");
      expect(row.rows[0].last_error).toContain("999");
      // The supported event still applies normally afterwards.
      const supported = claimed.find((e) => e.payloadVersion === 1)!;
      expect(await applyClaimedEvent(pool, con, supported, ACTOR)).toBe("applied");
    } finally {
      await cleanup([con]);
    }
  });

  it("acking an event that was never delivered is refused", async () => {
    const con = consumer("never");
    try {
      await expect(
        ackEvent(pool, con, "11111111-2222-4333-8444-555555555555", "applied"),
      ).rejects.toThrow(/not delivered/i);
    } finally {
      await cleanup([con]);
    }
  });
});

describe("P1-7: concurrent consumers", () => {
  it("two consumers stay independent and never duplicate inbox rows", async () => {
    const a = consumer("conca");
    const b = consumer("concb");
    try {
      await seedOpportunity("conca");
      await seedOpportunity("concb");
      const [ra, rb] = await Promise.all([claimEvents(pool, a, 50), claimEvents(pool, b, 50)]);
      expect(ra.length).toBe(2);
      expect(rb.length).toBe(2);
      // Same consumer claiming concurrently cannot duplicate either.
      const [r1, r2] = await Promise.all([claimEvents(pool, a, 50), claimEvents(pool, a, 50)]);
      expect(r1.every((e) => e.alreadySeen)).toBe(true);
      expect(r2.every((e) => e.alreadySeen)).toBe(true);
      const inbox = await pool.query(
        "select consumer_name, count(*)::int as n from p2.event_inbox where consumer_name = any($1) group by 1",
        [[a, b]],
      );
      expect(Object.fromEntries(inbox.rows.map((r: { consumer_name: string; n: number }) => [r.consumer_name, r.n]))).toEqual({
        [a]: 2,
        [b]: 2,
      });
      // Independent watermarks: settling A does not move B.
      await ackEvent(pool, a, ra[0].eventId, "applied");
      await ackEvent(pool, a, ra[1].eventId, "applied");
      expect((await consumerWatermark(pool, a)).appliedCount).toBe(2);
      expect((await consumerWatermark(pool, b)).appliedCount).toBe(0);
    } finally {
      await cleanup([a, b]);
    }
  });
});