# PHASE 2 EVENT, INBOX, OUTBOX AND RECONCILIATION CONTRACT

> **Migrations:** `...00001` (outbox + view), `...00002` (p2 schema + functions),
> `...00003/00004/00005/00007/00008` (forward repairs, each header-recorded).
> Companion: [interface spec](DISCOVERY_PHASE2_INTERFACE_SPEC.md) ·
> [Phase 2 schema](PHASE2_SCHEMA.md).
> No message broker exists and none may be introduced: the outbox table IS the
> queue.

## 1. Outbox (`public.discovery_outbox`)

One row per Discovery state change, written IN the changing transaction
(`registerOpportunity`, `transitionOpportunity`, `evaluateEligibility` all
commit state + audit + event atomically). Columns: `outbox_id` (global stream
position, identity), `event_id` (stable uuid, unique), `opportunity_id`,
`sequence` (per-opportunity, monotone from 1, allocated under a row lock —
gaps are impossible), `event_type` (exactly three values, CHECK-enforced),
`payload_version` (1; consumers refuse anything else), `payload` (facts only:
ids, keys, versions, decisions, transitions — never judgments),
`occurred_at`, `recorded_by` (required, 1..200 chars).

Event types: `opportunity_registered`, `opportunity_status_changed`,
`eligibility_decided`. No other type can be written (CHECK + function guard).

Durability rules: append-only (UPDATE refused at the DB level for every role);
DELETE only as the cascade consequence of removing the parent opportunity;
delivery is at-least-once; events exist only from the M9 deploy onward —
earlier history is covered by backfill + snapshots, never retro-fabricated.

## 2. Inbox (`p2.event_inbox`) and watermark (`p2.consumer_watermark`)

Delivery identity is per (consumer, event): composite PK
`(consumer_name, event_id)` plus unique `(consumer_name, outbox_id)`.
Statuses: `claimed` → `applied` | `rejected` | `dead`. `dead` IS the
dead-letter state: retained forever with `last_error`, counted, never deleted.

Watermark rule: `last_outbox_id` is the highest position whose events are ALL
settled for that consumer — the minimum unsettled position minus one — so a
gap keeps the watermark behind it instead of skipping work. It is additionally
guarded with `greatest()` against the stored value and can never move
backwards. `applied_count` / `dead_count` are maintained alongside.

## 3. The two functions (the entire consumption surface)

`p2.claim_events(consumer, batch)` — copies the next unsettled outbox rows
(above the watermark, `SKIP LOCKED`, max 200) into the inbox, idempotent per
(consumer, event); redelivery reports `already_seen` instead of duplicating.
`p2.ack_event(consumer, event_id, status, error?)` — settles one event;
re-acking returns the stored state and writes no second audit row; unknown
events are refused; bad statuses are refused (all 22023, never silent).

Both are SECURITY DEFINER with `search_path = p2, public`. The Phase 2 role
may EXECUTE them and SELECT inbox/watermark rows (delivery inspection), but
may NOT insert/update/delete inbox or watermark rows directly — dedup and
watermark invariants cannot be bypassed. Inside these functions every column
reference is table-qualified: unqualified names collide with the RETURNS TABLE
output parameters and fail at runtime (found twice during Part 1, repaired in
M12).

## 4. Three distinct operations (never automatic, never scheduled)

1. **Consume** (`consumePendingEvents` / `qualify.mjs consume`): claim one
   batch and apply it. Supported outcomes per event: `applied` (case created
   or refreshed, snapshot recorded, stream position advanced), `rejected`
   (contract refusal: unknown type, future payload version, opportunity gone
   from the view — terminal, recorded, never retried).
2. **Reconcile** (`reconcileCases` / `qualify.mjs reconcile`): compare every
   case with the CURRENT view. Flag drift (Discovery hash moved), report
   orphaned cases (opportunity gone from the view — the case is KEPT, the
   operator decides). Drift is NEVER auto-cleared.
3. **Replay** (`replayCase` / `qualify.mjs replay`): read-only reconstruction
   from retained `case_snapshot` rows + outbox payloads, in order. Never from
   the current view alone.

Plus **backfill** (`backfillCases`): creates cases for view rows that have
none — pre-outbox history and undelivered rows converge here; re-running
creates nothing and records no duplicate snapshots.

`reconcileAll` composes consume → backfill → reconcile, optionally under one
idempotency key (`qualify.mjs run-all --idempotency-key`). Manual-only is
asserted structurally by test (no scheduler primitives in the lib or script).

## 5. Poison, gaps, interruption, rollback

- **Poison:** the consumer retries under its own policy, then acks `dead`
  with the reason. The row stays, `dead_count` increments, the watermark
  advances past it only once settled. Nothing is deleted, nothing is skipped
  silently.
- **Gaps:** an unsettled event keeps the watermark behind it; later events
  settle but do not advance it. Tested out-of-order both ways.
- **Interruption:** a claimed-but-unacked event is reclaimed as
  `already_seen` and converges on the next apply. No loss, no duplication.
- **Rollback:** `withIdempotency` runs the function in a transaction — a throw
  stores nothing and leaves no partial writes (tested).
- **Concurrent claims:** two consumers stay independent with independent
  watermarks; the same consumer claiming concurrently cannot duplicate inbox
  rows (tested, including the PK repair that made multi-consumer delivery
  possible at all).

## 6. Backfill and replay boundaries

- Events exist only from the M9 deploy onward. Anything older enters Phase 2
  exclusively through backfill (view → case + snapshot).
- Replay reads retained snapshots and payloads; it never consults the current
  view, so a later Discovery change cannot rewrite what a past assessment saw.
- Orphaned cases (opportunity removed) are reported, kept, and auditable —
  never auto-deleted.

## 7. Contract tests

`tests/qualification_events.test.ts` (12): emission atomicity and ordering,
no-event-on-failed-change, outbox append-only, claim/apply/watermark,
duplicate delivery, interruption, out-of-order ack, idempotent re-ack, poison,
version rejection, undelivered-ack refusal, concurrent consumers.
`tests/qualification_reconcile.test.ts` (10): consume report, backfill
idempotency, drift + no-auto-clear, orphans, replay, reference rules,
workflow edges, idempotency transactions, manual-only scan, full composition.
