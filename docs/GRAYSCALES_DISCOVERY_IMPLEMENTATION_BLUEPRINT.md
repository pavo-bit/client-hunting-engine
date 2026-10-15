# GRAYSCALES DISCOVERY IMPLEMENTATION BLUEPRINT

> Design-only (Prompt 3). No code, migration, config, or DB change made.
> Everything below maps to verified repository facts; open decisions stay
> open (O-refs); unresolved parameters are labeled BLOCKED/PENDING, never defaulted.

## 1. Architecture map (reuse-first; new modules only where nothing fits)

| Responsibility | Existing module(s) | Change | Justification |
|---|---|---|---|
| Run lifecycle + controller | `lib/discovery/run.ts` (bounded single-query runs, idempotent items) | EXTEND: accept an optional task plan; per-task accounting; new end-states (`exhausted`, `time_stop`, `low_yield_stop`, `incomplete_coverage`) alongside existing ok/partial/failed/cancelled | Single-query path stays untouched; planner is additive |
| Coverage + query planning | — (absent) | NEW `lib/discovery/coverage.ts`: task-list build, per-task yield ledger, stopping-rule evaluation, shortfall report | Nothing existing plans multi-task refreshes |
| Source registry + orchestration | `lib/discovery/registry.ts`, `production.ts` | MODIFY: consult DB `source.enabled` at run start (or document code-registry as sole gate — B-D5 decision recorded in code either way) | Closes D0 gap P2; no behavior change for enabled sources |
| Adapters + manual observations | `lib/discovery/adapters/*`, `lib/intake/import.ts`, `lib/evidence/ingest.ts` | REUSE unchanged | Contract v1 + fixtures proven |
| Candidate extraction | `run.ts processRecord` | REUSE; add opportunity-key computation (new pure function in `lib/discovery/keys.ts`) | Keys are deterministic derivation, no new I/O |
| Business identity resolution | `lib/resolve/*` + `resolve_merge_company()` | REUSE unchanged (rules frozen) | 30/30 tests; boundaries forbid redesign |
| Opportunity resolution | — (absent) | NEW `lib/discovery/opportunities.ts`: key assignment, repost resolution, collision routing to review, promotion to hypothesis | Distinct from identity resolution by design |
| Evidence recording | `lib/evidence/*` | REUSE unchanged | Provenance + contradiction discipline frozen |
| Eligibility evaluation | `lib/scoring/evaluate.ts` (downstream gates) | NEW `lib/discovery/eligibility.ts`: discovery-side screen emitting versioned decisions with gate reasons (O10-gated content, structure now) | Scoring gates stay downstream and untouched |
| Persistence + audit | `pg` + `lib/intake/db.ts` + `audit_log` | REUSE; transitions logged as `entity_type='opportunity'` (project convention, no new history table) | Append-only guarantee inherited |
| Batch finalization + reports | run `finish()` | EXTEND: six-measure counters (§4A) + end-state vocabulary (§4C) | Same transaction pattern |
| Discovery UI + review queues | `app/discovery`, `app/api/discovery/*`, `app/review`, `app/api/candidates/*` | EXTEND pages/endpoints (see API contracts); reuse queue + candidate workflows | No workflow duplication |

## 2. Database blueprint (specified, NOT created — Prompt 4 material)

Naming: `20261015xxxxxx_*.sql` (exact stamps assigned at creation; logical
order below is normative). All additive; no column drops/renames; RLS +
REVOKE mirroring existing tables; owner-connection access like the rest.

### M1 — `discovery_coverage_task` (task accounting + stopping rules)
Columns: `id uuid PK`, `run_id FK discovery_run(id) ON DELETE CASCADE`,
`adapter_id`, `query_text`, `page_token nullable`, `status CHECK
(pending|running|done|exhausted|failed|skipped_low_yield)`,
`yield_new integer default 0`, `yield_total integer default 0`,
`attempts integer default 0`, `started_at/finished_at timestamptz`,
`note text`. Indexes: `(run_id, status)`, `(adapter_id, started_at)`.
Transactions: task claim via single `UPDATE … WHERE status='pending'
RETURNING` (skip-locked unnecessary single-operator; row lock suffices).
Backfill: none (new table). Forward-repair only (runner has no down support).

### M2 — `opportunity` (per-pipeline stable identity)
Columns: `id uuid PK`, `pipeline text CHECK (agency_partner|direct_client)`,
`opportunity_key text`, `company_id FK company(id) ON DELETE RESTRICT`,
`rule_id nullable` (discovery rule or null for manual),
`status CHECK (observed|eligible|ineligible|promoted|stale|archived)`,
`solution_status CHECK (unknown|absent_evidence|present_confirmed|
present_unverified) default 'unknown'`, `first_seen_at`, `created_at`,
`updated_at`. Constraints: `UNIQUE (pipeline, opportunity_key)`;
`CHECK (pipeline <> 'direct_client' OR TRUE)` — direct-client ROWS forbidden
at application level until O1 (schema permits, code refuses; documented).
Indexes: `(pipeline, status)`, `(company_id)`. Key format (normative):
`opp:<pipeline>:<source-key>:<source-record-id>` for adapter records,
`opp:<pipeline>:manual:<ulid-ish>` for manual ones; canonicalization =
lowercase, trim, stable field order. Relationships (`business_relationship`):
`(company_a, company_b, rel_type CHECK (parent|subsidiary|alias_network|sibling),
note)` — display/review only, zero merge semantics, no FK cascades beyond RESTRICT.

### M3 — `opportunity_eligibility` (versioned decisions, append-only)
Columns: `id uuid PK`, `opportunity_id FK opportunity ON DELETE CASCADE`,
`version int`, `decision CHECK (eligible|ineligible|needs_info)`,
`gate_reasons jsonb` (failing gate/rule IDs + human text),
`policy_version text` (D-* snapshot ref), `decided_by/at`. Constraint:
`UNIQUE (opportunity_id, version)`; NO update/delete path (application +
REVOKE like audit_log; trigger optional). Re-evaluation appends version+1.

### M4 — brief policy snapshot (additive ALTERs, nullable)
`alter table public.brief add column policy_version text;` (+ optional
`add column rule_version text` if hypothesis version insufficient). Nullable:
old briefs read as `policy_version IS NULL` = "pre-snapshot era" (honest,
not backfilled with invented values).

### Ordering, locking, rollback
Order M1→M2→M3→M4 (FK chain). Locking: existing patterns (ordered row locks
on merges; single-statement claims; unique indexes as idempotency arbiters).
Compatibility: all nullable/FK-safe against existing rows; `verify` suite
extended with new-table presence checks (Prompt 4). Rollback: forward-repair
migrations only — destructive down-migrations prohibited on dev; scratch
verification before apply.

## 3. Deterministic algorithms (pseudocode + edge cases)

**Identity resolution** — UNCHANGED (frozen): registry-scoped+type >
domain-exact (minus 28 shared hosts) > verified aliases > name-exact
(review only); verified human-only; auto-merge domain-exact conflict-free,
older wins. Edge: shared-host domains never merge; conflicting registries
block auto-merge (explicit override audited). (O1 may add pipeline-scoped
views later; rules themselves frozen.)

**Opportunity dedup/collisions** — `key(record)` per M2; on key hit:
same canonical company → `duplicate_observations++`, link evidence, no new
row; same key + different canonical → `collision` → review candidate with
both provenances (never auto-split/merge); repost (identical content hash)
→ same key by construction. Edge: key with null company (unresolved
identity) → opportunity parks at `observed`, promotion blocked until
identity resolves (gate, not silent drop).

**Evidence independence/provenance** — distinct (source_key, origin-host)
pairs; corroboration needs ≥2 (existing rule); excerpts bounded; PII
minimized; every observation carries actor + URL + observed-at.

**Freshness/contradictions** — expiry horizons per claim (existing); expired
basis triggers stale handling (existing); `contradicts` links preserved +
surfaced; open contradictions block validation AND eligibility (O10-gated
wording, structure now).

**Eligibility (versioned)** — evaluate gates in fixed order
(identity-resolved → support threshold [PENDING O10 values] → no open
contradiction → solution_status ≠ present_confirmed → freshness); first
failure decides `ineligible` with gate IDs; append version row; re-evaluate
appends, never edits. Edge: re-evaluation after new evidence supersedes
prior version (history kept).

**Promotion** — `eligible` + human promotion decision → hypothesis creation
via existing engine (rules unchanged); promotion records hypothesis id on
the opportunity (`promoted`), one promotion per opportunity version
(unique partial index; repeat promotion attempts return existing link).

**New-vs-promoted counting** — counters increment exactly at commit points:
`new_eligible` on first eligible-version commit; `promoted` on promotion
commit; `new_evidence` on observation commit to known opportunities;
duplicates/excluded tallied at classification time. Only `new_eligible`
feeds the 50-target (normative).

**Coverage/stop accounting** — planner emits task list (BLOCKED O4 for
defaults); executor claims tasks, records per-task yield, evaluates stops in
order: tasks-exhausted → `exhausted`; wall-clock → `time_stop`; N
consecutive zero-yield → `low_yield_stop` (N PENDING O4, PROPOSAL 3);
concentration cap hit → note + reroute (PENDING O4); adapter failure →
`partial` + continue. Final state ∈ {`exhausted`,`time_stop`,
`rate_limited`,`safety_stop`,`partial`,`incomplete_coverage`} (extends,
never renames, existing six).

**Partial failures/finalization** — per-item outcomes (existing six);
finalize writes all six §4A counters + end-state in ONE transaction with the
run row (existing `finish()` pattern extended).

**Retry/concurrency** — rate-limit/network classes retry bounded w/ backoff;
terms/auth/injection never retry (existing). Concurrent refreshes: allowed;
uniques arbitrate (run_item, opportunity key, canonical identity); no global
lock (single-operator; document the assumption). Crashed runs: B-D6 reaping
(not this blueprint's code — listed dependency).

## 4. Implementation order (brief §7 kept; justification noted)

1. Persistence (M1–M4) — FK chain demands schema first. 2. Lifecycle +
   deterministic rules (`opportunities.ts`, `keys.ts`, eligibility
   structure) — needs tables. 3. Registry + coverage (`coverage.ts`,
   `enabled` wiring) — needs M1. 4. Extraction/identity/opportunity
   resolution — needs 1–2. 5. Eligibility + counting — needs O10/O3/O2
   wording (structure now, values on approval). 6. API. 7. UI. 8. Verify +
   docs. No reorder justified by evidence.

## 5. Dependency graph

M1–M4 → `keys.ts`/`opportunities.ts` → `coverage.ts` → `eligibility.ts` →
API → UI → tests/docs. Cross-cutting: O1/O2/O3/O4/O10 approvals gate
release (not construction) of 5–7; B-D5/B-D6 are independent small tasks;
auth/audit/test-conventions reused throughout (no new infra).

## 6. Requirement-to-test traceability (design-time; cases in TEST_PLAN)

Amendment §§4A–4H → blueprint §§2–3 → test-plan IDs T-DISC-*. BLOCKED items
(O-gated) trace to explicitly-marked pending tests, never to skipped ones.

## 7. Outstanding blockers (pointer)

`docs/DISCOVERY_BLOCKERS_AND_TRACEABILITY.md` B-D1…B-D10 — unchanged by this
document; B-D5/B-D6 are the only blockers buildable without owner words.
Migration risks: additive-only safety + forward-repair rule (§2);
prerequisites: O-decisions for release, scratch-verified migrations before
dev apply, `verify` + R-02/R-03 suites green after.
