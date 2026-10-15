// Discovery change notifications (Part 1, migration M9).
//
// Every state change Discovery persists ALSO appends one row to
// `public.discovery_outbox`, inside the SAME transaction, through the
// `discovery_append_event()` function. That function allocates the
// per-opportunity sequence under a row lock, so the event stream and the state
// it describes can never disagree: no event without the state, no state
// without the event, no skipped sequence numbers.
//
// Only three event types exist (the migration's CHECK enforces this):
//   opportunity_registered     — a new opportunity row was created;
//   opportunity_status_changed — a lifecycle transition was applied;
//   eligibility_decided        — an eligibility version was appended.
// Payloads are facts (ids, keys, versions, decisions), never Phase 2
// judgments. Payload envelope version is 1; consumers must refuse versions
// they do not understand rather than guess.

import type { Pool, PoolClient } from "pg";

export type DiscoveryEventType =
  | "opportunity_registered"
  | "opportunity_status_changed"
  | "eligibility_decided";

/** Payload envelope version produced by this code. Consumers refuse unknown versions. */
export const DISCOVERY_EVENT_PAYLOAD_VERSION = 1;

export interface DiscoveryEventInput {
  opportunityId: string;
  eventType: DiscoveryEventType;
  /** Facts only: ids, keys, versions, decisions. No judgments. */
  payload: Record<string, unknown>;
  /** Session operator (routes) or explicit caller (library). Never a default. */
  recordedBy: string;
}

/**
 * Append one outbox event on an already-held client inside the caller's
 * transaction. Returns the stable `event_id`. Throws 22023 on an unknown
 * event type, missing attribution, or a missing opportunity row.
 */
export async function appendDiscoveryEvent(
  client: PoolClient,
  input: DiscoveryEventInput,
): Promise<string> {
  const r = await client.query(
    "select public.discovery_append_event($1, $2, $3, $4) as event_id",
    [
      input.opportunityId,
      input.eventType,
      JSON.stringify(input.payload ?? {}),
      input.recordedBy,
    ],
  );
  return r.rows[0].event_id as string;
}

export interface OutboxEvent {
  outboxId: number;
  eventId: string;
  opportunityId: string;
  sequence: number;
  eventType: string;
  payloadVersion: number;
  payload: unknown;
  occurredAt: Date;
  recordedBy: string;
}

/** Read the durable event history of one opportunity, in stream order. */
export async function outboxEventsFor(
  pool: Pool,
  opportunityId: string,
): Promise<OutboxEvent[]> {
  const r = await pool.query(
    `select outbox_id, event_id, opportunity_id, sequence, event_type,
            payload_version, payload, occurred_at, recorded_by
     from public.discovery_outbox
     where opportunity_id = $1
     order by sequence`,
    [opportunityId],
  );
  return (r.rows as {
    outbox_id: string;
    event_id: string;
    opportunity_id: string;
    sequence: string;
    event_type: string;
    payload_version: number;
    payload: unknown;
    occurred_at: Date;
    recorded_by: string;
  }[]).map((x) => ({
    outboxId: Number(x.outbox_id),
    eventId: x.event_id,
    opportunityId: x.opportunity_id,
    sequence: Number(x.sequence),
    eventType: x.event_type,
    payloadVersion: x.payload_version,
    payload: x.payload,
    occurredAt: x.occurred_at,
    recordedBy: x.recorded_by,
  }));
}
