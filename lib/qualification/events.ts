// Phase 2 event consumption (Part 1).
//
// Delivery is at-least-once over the shared database: `p2.claim_events`
// copies the next unsettled outbox rows into this consumer's inbox
// (idempotent per consumer+event), and `p2.ack_event` settles them one by one.
// Redelivery after an interruption is therefore safe — the inbox row is
// already there and is reported as `already_seen` instead of duplicated.
//
// Payload discipline: this consumer understands envelope v1 with the three
// Discovery event types. Anything else (a future v2, an unknown type) is
// REJECTED — a contract refusal, terminal, never retried — rather than
// misapplied. Truly unprocessable rows (corrupt payload shape) are DEAD:
// retained as dead letters and counted, never deleted, and the watermark
// advances past them only once they are explicitly settled that way.

import type { Pool, PoolClient } from "pg";
import { DISCOVERY_EVENT_PAYLOAD_VERSION } from "../discovery/events.ts";
import { ensureCase, markCaseDrift, recordSnapshot } from "./cases.ts";
import { readQualificationRow, stateHashOf } from "./view.ts";

export interface ClaimedEvent {
  eventId: string;
  outboxId: number;
  opportunityId: string;
  eventType: string;
  payloadVersion: number;
  opportunitySequence: number;
  payload: unknown;
  occurredAt: Date;
  recordedBy: string;
  alreadySeen: boolean;
}

export interface AckResult {
  eventStatus: string;
  lastOutboxId: number;
  unsettled: number;
}

/** Copy the next unsettled outbox rows into this consumer's inbox. */
export async function claimEvents(
  db: Pool | PoolClient,
  consumer: string,
  batch = 50,
): Promise<ClaimedEvent[]> {
  const r = await db.query("select * from p2.claim_events($1, $2)", [consumer, batch]);
  return (r.rows as {
    event_id: string;
    outbox_id: string;
    opportunity_id: string;
    event_type: string;
    payload_version: number;
    opportunity_sequence: string;
    payload: unknown;
    occurred_at: Date;
    recorded_by: string;
    already_seen: boolean;
  }[]).map((x) => ({
    eventId: x.event_id,
    outboxId: Number(x.outbox_id),
    opportunityId: x.opportunity_id,
    eventType: x.event_type,
    payloadVersion: x.payload_version,
    opportunitySequence: Number(x.opportunity_sequence),
    payload: x.payload,
    occurredAt: x.occurred_at,
    recordedBy: x.recorded_by,
    alreadySeen: x.already_seen,
  }));
}

/** Settle one delivered event. Terminal: applied | rejected | dead. */
export async function ackEvent(
  db: Pool | PoolClient,
  consumer: string,
  eventId: string,
  status: "applied" | "rejected" | "dead",
  error?: string,
): Promise<AckResult> {
  const r = await db.query("select * from p2.ack_event($1, $2, $3, $4)", [
    consumer,
    eventId,
    status,
    error ?? null,
  ]);
  const row = r.rows[0] as { event_status: string; last_outbox_id: string; unsettled: string };
  return {
    eventStatus: row.event_status,
    lastOutboxId: Number(row.last_outbox_id),
    unsettled: Number(row.unsettled),
  };
}

/** Current consumer watermark (0 when the consumer never settled anything). */
export async function consumerWatermark(
  db: Pool | PoolClient,
  consumer: string,
): Promise<{ lastOutboxId: number; appliedCount: number; deadCount: number }> {
  const r = await db.query(
    "select last_outbox_id, applied_count, dead_count from p2.consumer_watermark where consumer_name = $1",
    [consumer],
  );
  if (r.rows.length === 0) return { lastOutboxId: 0, appliedCount: 0, deadCount: 0 };
  return {
    lastOutboxId: Number(r.rows[0].last_outbox_id),
    appliedCount: Number(r.rows[0].applied_count),
    deadCount: Number(r.rows[0].dead_count),
  };
}

export type ApplyOutcome = "applied" | "rejected";

/**
 * Apply ONE claimed event to the case store, then settle it.
 *
 *   registered      -> ensure the case exists from the current view row;
 *   status_changed / eligibility_decided -> refresh the case's stream position
 *     and snapshot; flag drift when Discovery's hash no longer matches.
 *
 * Returns the outcome; the caller decides nothing further. A missing view row
 * (the opportunity was removed) is REJECTED with the reason recorded — the
 * event stays in history, the case keeps pointing at a gone opportunity, and
 * reconciliation reports it as orphaned.
 */
export async function applyClaimedEvent(
  db: Pool | PoolClient,
  consumer: string,
  event: ClaimedEvent,
  actor: string,
): Promise<ApplyOutcome> {
  if (event.payloadVersion !== DISCOVERY_EVENT_PAYLOAD_VERSION) {
    await ackEvent(db, consumer, event.eventId, "rejected", `unsupported payload version ${event.payloadVersion}`);
    return "rejected";
  }
  if (
    event.eventType !== "opportunity_registered" &&
    event.eventType !== "opportunity_status_changed" &&
    event.eventType !== "eligibility_decided"
  ) {
    await ackEvent(db, consumer, event.eventId, "rejected", `unknown event type ${event.eventType}`);
    return "rejected";
  }
  const row = await readQualificationRow(db as Pool, event.opportunityId);
  if (!row) {
    await ackEvent(db, consumer, event.eventId, "rejected", "opportunity no longer visible in the qualification view");
    return "rejected";
  }
  const { kase } = await ensureCase(db, row, actor);
  const hash = stateHashOf(row);
  const seq = event.opportunitySequence;
  await db.query(
    `update p2.case
     set latest_sequence = greatest(latest_sequence, $2),
         discovery_updated_at = $3
     where case_id = $1`,
    [kase.case_id, seq, (row.opportunity_updated_at as Date)?.toISOString?.() ?? new Date().toISOString()],
  );
  await recordSnapshot(db, kase.case_id, row, actor, `event:${event.eventType}`);
  if (hash !== kase.discovery_state_hash) {
    await markCaseDrift(db, kase.case_id, hash);
  }
  await ackEvent(db, consumer, event.eventId, "applied");
  return "applied";
}
