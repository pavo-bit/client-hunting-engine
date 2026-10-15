# GRAYSCALES — PHASE-2 TECHNICAL HANDOFF (Discovery → Qualification & Prioritization)

> **Date:** 2026-10-15 · **Status:** planning input. **No Phase-2 code, tables or
> scoring algorithms were created.** This document describes what Discovery
> actually exposes today, what it deliberately does not, and the exact contract
> changes Phase 2 must wait for.
>
> Companion documents: `GRAYSCALES_DISCOVERY_FINAL_VERIFICATION_REPORT.md`,
> `GRAYSCALES_DISCOVERY_FINDINGS_REGISTER.md`,
> `GRAYSCALES_DISCOVERY_TEST_TRACEABILITY.md`.

---

## 1. What Phase 2 may safely build on

Discovery is complete as *structure*: it finds businesses from permitted
sources, records provenance, accumulates opportunities, refuses to invent
identity or eligibility, and exposes read-only projections. Phase 2 can consume
all of that without re-running discovery and without altering evidence.

**What Phase 2 must not do:** re-decide eligibility, rewrite claims/snapshots,
merge companies, transfer shortfall between pipelines, or treat any `observed`
opportunity as qualified. Eligibility content is owner-gated (O10); until it
exists, `new_eligible` is legitimately 0.

---

## 2. Discovery APIs — as-built response contracts

All routes require `requireOperatorApi` (401 JSON otherwise); POST routes also
require `requireSameOrigin` (403). Actor attribution is the session operator;
a body-supplied `actor` is ignored.

### `GET /api/opportunities` — accumulated collection (read-only)
Query: `pipeline=agency_partner|direct_client` (default `agency_partner`),
`status=`, `q=` (≤200 chars, substring over key and company name), `limit=` (1..200,
default 50), `offset=` (≥0, default 0).

```jsonc
{ "total": 128, "limit": 50, "offset": 0,
  "items": [{
    "id": "uuid", "pipeline": "agency_partner",
    "opportunity_key": "opp:agency_partner:gleif-api:5493001kjtiigc8y1r12",
    "status": "observed",            // observed|eligible|ineligible|promoted|stale|archived
    "solution_status": "unknown",    // unknown|absent_evidence|present_confirmed|present_unverified
    "first_seen_at": "iso", "created_at": "iso",
    "company_id": "uuid|null", "company_name": "string|null"
  }] }
```
`total` always accompanies capped rows — no silent omission, no total cap.

### `GET /api/opportunities/[key]?pipeline=` — one opportunity + history
```jsonc
{ "opportunity": { "id","pipeline","opportunity_key","status","solution_status",
                   "first_seen_at","created_at","updated_at",
                   "company_id","company_name","domain_norm","registry_id","merged_into" },
  "evidence": [ { "id","text","claim_status","url","source_key","created_at" } ],
  "eligibility_history": [ { "id","opportunityId","version","decision",
                             "gateReasons","policyVersion","decidedBy","decidedAt" } ],
  "lifecycle": [ { "transition_from","transition_to","actor","reason","created_at" } ] }
```
404 `opportunity_not_found`; 422 `bad_pipeline`. `eligibility_history` is
**empty** for opportunities never evaluated (O10) — that is honest, not missing
data.

### `POST /api/discovery/refreshes` — manual planned refresh (201)
Body `{tasks:[{adapterId,queryText,limit?,maxPages?}], stop?{lowYieldStreak,concentrationCap}?}`.
Response: `{runId, status, tasksPlanned, tasksDone, stoppedBy, finalized,
unattributedSourceRecords, endState, measures}`.
`status` ∈ `ok|partial|failed|cancelled`; `stoppedBy` ∈ `completed|thresholds|deadline`;
`finalized:false` means someone else (the reaper) already closed the run — in
that case `status` is what is **stored**, not what the worker computed.

### `GET /api/discovery/refreshes/[id]?target_agency=&target_direct=` — status
`{runId, runStatus, endState, coverage{...}, measures{...}, shortfall[]}`.
`endState` ∈ `exhausted|partial|low_yield_stop|time_stop|failed|incomplete_coverage`.
Shortfall rows are per pipeline and never netted.

### `POST /api/discovery/reap` — operator-triggered crash recovery
`{staleAfterMinutes, dryRun?, actor?}` → `{dryRun, staleAfterMinutes, considered[],
reaped[{runId,tasksFailed}]}`. Manual only, dry-run first, no scheduler.

### Reused, unchanged by Phase 1 discovery work
`POST/GET /api/discovery/runs[/[id]]` (single-query runs),
`/api/candidates[/[id]/*]` (ambiguous-identity review), `/api/companies`,
`/api/claims[/[id]/*]`, `/api/evidence/*`, `/api/hypotheses/*`,
`/api/briefs/*`, `/api/proposals/*`, `/api/drafts/*`, `/api/scores/*`,
`/api/resolve`, `/api/adapters`, `/api/auth/*`, `/api/health` (the only public
route).

---

## 3. Data structures Phase 2 will read

| Table | Role | Key columns / rules |
|---|---|---|
| `company` | canonical business | `domain_norm` **nullable** (registry sources carry no domain), `registry_id`, `merged_into` (never set automatically) |
| `discovery_record` | provenance of one sighting | `source_key` FK → `public.source`, `source_record_id`, `collection_method`, `retrieval_status` |
| `discovery_run` | one single-query run **or** one refresh parent | `status` ∈ `running|ok|partial|failed|cancelled`, `created_by`, `found/created_new/duplicates/skipped/conflicts/failed_items` |
| `discovery_run_item` | per-record outcome | `status` ∈ `new|duplicate|skipped|invalid|conflict|failed` |
| `discovery_coverage_task` | frozen per-task ledger | `status` ∈ `pending|running|done|exhausted|failed|skipped_low_yield`, `plan_seq`, `yield_new/yield_total`, `child_run_id`, `note` |
| `opportunity` | the unit Phase 2 ranks | `opportunity_key` (unique per pipeline), `status`, `solution_status`, `first_seen_at`, `run_id` |
| `opportunity_eligibility` | append-only eligibility history | `version ≥ 1`, `decision` ∈ `eligible|ineligible|needs_info`, `policy_version`, `decided_by`; **UPDATE forbidden at the DB level** |
| `business_relationship` | display/review only | `rel_type` ∈ `parent|subsidiary|alias_network|sibling`; zero merge semantics, RESTRICT |
| `identity_conflict` | review artifact | one per (run, record, rule); `status` ∈ `pending|reviewed|deferred`; attribution via `conflictAttribution()` |
| `claim` / `snapshot` | evidence | claims append-only; snapshots immutable except deletion with the parent |
| `match_candidate` | ambiguous-identity review queue | consumed by human review, never auto-resolved |

**Pipeline identifiers:** exactly two literals exist in the schema —
`'agency_partner'` and `'direct_client'`. `direct_client` is refused by the
application (409 `direct_client_blocked`) until O1 is decided. No third
pipeline exists.

---

## 4. Counters and their exact semantics (critical for Phase 2)

| Counter | Meaning | Frozen or live |
|---|---|---|
| `coverage.yield_new` / `yield_total` | what the task's run found/created **at the time** | **FROZEN** (task ledger) |
| `coverage.<status>` counts | terminal states of tasks | **FROZEN** |
| `measures.new_eligible` | opportunities of this run whose lifecycle status is `eligible` **right now** | LIVE |
| `measures.promoted` | …status `promoted` right now | LIVE |
| `measures.excluded` / `stale` | …`ineligible` / `stale` right now | LIVE |
| `measures.duplicates` | run items recorded as duplicates for this run's child runs | from immutable rows |
| `measures.new_evidence` | distinct claims created for this run's companies inside the run window | from immutable rows |
| `measures.unresolved` | `unresolved_opportunities + unresolved_tasks` | LIVE |
| `measures.unresolved_opportunities` | opportunities awaiting a human decision (`observed`) | LIVE |
| `measures.unresolved_tasks` | tasks not yet terminal (`pending`/`running`) | LIVE |
| `measures.measures_basis` | always `"live_projection"` — stated in the payload so it cannot be misread | — |

**Consequence:** promoting an opportunity later changes what a *historical*
run reports. To reconstruct what a run intended, read the task ledger and the
append-only `opportunity_eligibility` history — never a past `measures` object.

---

## 5. Eligibility state today

- `opportunity.status` is **lifecycle**, not qualification:
  `observed → eligible | ineligible | archived`, `eligible → promoted | ineligible | stale | archived`,
  and so on. Allowed edges are enforced in `lib/discovery/opportunities.ts` and audited.
- `opportunity_eligibility` stores versioned decisions with an explicit
  `policy_version` and per-gate `gate_reasons`; the **content** of those gates is
  supplied by the caller and is currently O10-gated. Nothing in Discovery decides
  eligibility on its own.
- Therefore: **Phase 2 must not assume `status='eligible'` is populated.** It is
  0 today by design. Phase 2 should consume `opportunity_eligibility` history
  when it exists and treat its absence as "not yet decided", never as "failed".

---

## 6. Recommendation: how Phase 2 should consume Discovery

1. **Read the collection, not the runs.** `GET /api/opportunities` is the
   accumulated, paginated, filterable source of truth for "what do we have".
   Runs are history about how we found it.
2. **Never re-derive identity.** Business identity is `company.id`; ambiguous
   businesses are already routed to `match_candidate`/`identity_conflict`. Rank
   the opportunity, not the string similarity of names.
3. **Keep the append-only boundaries.** Phase 2 adds decisions, hypotheses,
   briefs and scores — all of which already have append-only or audited paths.
   Do not add UPDATEs to claims, snapshots or eligibility history; the database
   now refuses them.
4. **Make your ranking inputs explicit and versioned.** If Phase 2 introduces
   weights, record them the way Discovery records eligibility: an explicit
   `weight_version` on the run plus a per-row explanation. D-006/O7 are still
   OPEN, so any weighting stays provisional until the owner authorizes it.
5. **Report honestly.** Use the existing shortfall pattern: per-pipeline rows,
   never transferred; a target that is not met is reported as a shortfall, never
   met by relaxing criteria.
6. **Leave discovery runs alone.** Do not re-run discovery to feed ranking, do
   not add sources, do not widen the 120 s budget. Refreshes are operator
   actions.

---

## 7. Known limitations Phase 2 inherits

| Limitation | Effect on Phase 2 |
|---|---|
| Eligibility content unimplemented (O10) | Nothing is `eligible`; ranking has no qualified population until the owner decides |
| Direct-client pipeline refused (O1) | Plan for agency-partner only |
| No allocation policy (O2/O3) | Shortfalls are reported raw, per pipeline |
| One live adapter (GLEIF, O9/D-003) | Narrow population; GLEIF companies have `domain_norm = NULL` |
| Live projections for run counters | Do not use historical `measures` for audit-grade claims |
| No run resume; reaper has no heartbeat | A reaped run is terminal; re-run the plan |
| Service-identity policy undefined (B-D13) | Attribution is trustworthy only for session-authenticated operators |
| `new_evidence` is 0 for fixture sources | Not a defect: fixture records carry no registry id, so no identity claim is generated |

---

## 8. Contract changes Phase 2 must wait for

| Waiting on | What becomes possible |
|---|---|
| **O10** (eligibility criteria) | A real eligible population to rank. Until then, ranking "eligible" opportunities is a no-op by design. |
| **O1** (direct-client scope) | Any `direct_client` work; today the app refuses those rows. |
| **O2/O3** (allocation + counting basis) | Cross-pipeline targets, allocation-aware shortfalls, acceptance of the §4A measures. |
| **O7 / D-006** (weights) | Any weighting beyond a provisional, clearly labelled ordering hint. |
| **O9 / D-003** (adapter set) | Broadening the population with new sources. |
| **B-D13** (service identity) | Machine-caller attribution that can be relied on in an audit. |
| **F18** (frozen run counters) | Audit-grade "what this run found" numbers. Until then use the task ledger. |

---

## 9. Interfaces Phase 2 can rely on today (stable)

- `opportunity.opportunity_key` — stable per-pipeline identity; safe to store
  and re-resolve. Never rewritten.
- `company.id` + `merged_into` — canonical business reference.
- `discovery_record (source_key, source_record_id)` — stable sighting identity;
  the basis of idempotent reruns.
- `opportunity_eligibility (opportunity_id, version)` — append-only decision
  history; the audit-grade record of qualification intent.
- `audit_log` — every consequential transition, append-only, with actor/reason.
- The five Discovery HTTP routes in §2 — shapes pinned by tests; additive
  changes only.

Phase 2 must not assume any of these will be renumbered, re-keyed, or silently
reinterpreted — and any change to them is a Discovery contract change requiring
an owner decision and a migration.