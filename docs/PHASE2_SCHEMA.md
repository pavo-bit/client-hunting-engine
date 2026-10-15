# PHASE 2 SCHEMA AND OWNERSHIP (Part 1 foundation)

> **Migration:** `db/migrations/20261015100002_phase2_foundation.sql`
> (repaired forward-only by `...00007_inbox_per_consumer_key.sql` and
> `...00008_p2_principal_policies.sql`).
> Companion: [interface spec](DISCOVERY_PHASE2_INTERFACE_SPEC.md) ·
> [event contract](PHASE2_EVENT_CONTRACT.md).
> Library: `lib/qualification/` (`view.ts`, `state.ts`, `cases.ts`,
> `events.ts`, `reconcile.ts`). Operator commands: `scripts/qualify.mjs`.

## 1. Ownership boundary

The `p2` schema is Phase 2's property; `public` (Discovery) is read-only to
it. Nothing in `p2` references `public.opportunity` by foreign key — the
identifier is stored as a plain uuid plus the key text, so Phase 2 can never
block, cascade or lock a Discovery row. Drift between the stored identifier
and Discovery truth is detected by reconciliation, not prevented by
constraints. Phase 2 never updates Discovery-owned records (proven: the Phase
2 role is denied direct writes AND direct reads on Discovery tables).

Deliberate omissions (not oversights): no scoring weights, no rubric or
eligibility CONTENT (owner decisions O3/O10/O7 stay OPEN — inventing them is
forbidden), no lifecycle UI, no autonomous worker, no scheduler, no outreach.
`p2.case.status` is WORKFLOW state only, never a qualification verdict.

## 2. Tables

| Table | Role | Identity / integrity |
|---|---|---|
| `p2.case` | one row per Discovery opportunity under qualification | unique `discovery_opportunity_id`; `status` ∈ discovered\|assessing\|assessed\|rejected\|archived with enforced edges; `discovery_state_hash` + `discovery_updated_at` = last reconciled truth; `drift_detected_at` never auto-cleared; `latest_sequence` = consumed stream position |
| `p2.case_snapshot` | immutable capture of the exact view row a decision was made against | unique `(opportunity_id, row_hash)` → re-capturing identical state deduplicates; `schema_version` = view version consumed |
| `p2.case_assessment` | immutable versioned assessments | unique `(case_id, version)`, monotone under a case lock; cites `rubric_version` / `policy_version` / `service_catalog_version` (must exist and not be retired) and optionally its input snapshot |
| `p2.audit_event` | append-only audit (identity rows) | UPDATE refused at DB level; DELETE only via case cascade |
| `p2.idempotency_record` | transactional idempotency keys | PK `(scope, key)`; same key + same request → stored result; same key + different request → refused |
| `p2.event_inbox` | per-consumer deliveries | composite PK `(consumer_name, event_id)` (repaired in M15 — a global PK starved every second consumer); unique `(consumer_name, outbox_id)`; rows never deleted |
| `p2.consumer_watermark` | per-consumer stream position | contiguous-prefix rule (see event contract) |
| `p2.reference_version` | version registry for policy / service_catalog / rubric / schema | PK `(kind, version)`; lifecycle draft → active → retired, timestamped; new decisions may cite existing non-retired versions only |

Append-only discipline follows the established T-007 pattern: assessments and
audit rows refuse UPDATE for every role; DELETE stays possible only as a
cascade from the parent case (test isolation), mirroring `claim_assessment`
and `opportunity_eligibility`.

## 3. Transactional boundaries

- Discovery writes (state + audit + event) commit atomically in the
  Discovery transaction. Phase 2 cannot observe a state without its event.
- `recordAssessment` takes the case lock and appends version N+1 atomically;
  concurrent writers serialize instead of colliding.
- `withIdempotency` runs the function and its idempotency record in one
  transaction: a throw leaves neither partial work nor a stored result.
- Consumption functions (`claim`/`ack`) are single-statement-safe SECURITY
  DEFINER units; each claim/ack is independently retryable (at-least-once).

## 4. Permissions

Role `p2_app` (created by `scripts/db.mjs bootstrap`, like `noaccess`):
EXECUTE on the two consumption functions; column-SELECT on the frozen view
except operator attribution; SELECT on inbox/watermark; INSERT+SELECT on its
six domain tables plus column-restricted UPDATE on `p2.case`; RLS policies
permit exactly that and nothing else; NO DELETE anywhere; NO access to any
Discovery table (proven by `tests/qualification_permissions.test.ts`, which
connects as the role). `noaccess` is denied everything including the view and
the functions.

## 5. Operator commands (`scripts/qualify.mjs`)

`consume --consumer` · `backfill [--pipeline]` · `reconcile` ·
`run-all --consumer [--idempotency-key]` · `status --consumer` ·
`replay --case`. All local-only (refuse non-loopback targets); writes require
`--actor` (defaulting to the operator's own `OPERATOR_EMAIL`, never a guess).
Nothing in the repository invokes these except an explicit operator command —
asserted by test.
