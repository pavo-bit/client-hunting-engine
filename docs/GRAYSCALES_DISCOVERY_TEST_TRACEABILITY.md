# GRAYSCALES DISCOVERY — REQUIREMENT-TO-TEST TRACEABILITY MATRIX

> **Date:** 2026-10-15. Supersedes the matrix inside
> `docs/DISCOVERY_BLOCKERS_AND_TRACEABILITY.md` §2 (preserved as an audit
> record).
>
> Status key: **TESTED** (asserted by a test that was executed in this session)
> · **VERIFIED-BY-SCHEMA** (proved by `db/tests/t002_verify.sql`) · **BLOCKED**
> (structure exists, content needs an owner decision) · **NOT RE-EXECUTED**
> (proven earlier, not re-run in this gate).

## 1. Discovery lifecycle

| Requirement | Implementation | Test | Status |
|---|---|---|---|
| Manual refresh only, no scheduler | `runRefresh`, `POST /api/discovery/refreshes`; no schedule endpoint exists | Absence + route inventory | TESTED |
| Overall 120 s budget (approved contract) | `DEFAULT_REFRESH_BUDGET_MS`, deadline checked before every claim | `discovery_refresh_deadline.test.ts` (7) | TESTED |
| Terminal state on deadline | parent `cancelled`; unstarted tasks `failed` + reason; never `skipped_low_yield` | same | TESTED |
| Bounded plan (1..25 tasks, 25×3 pages) | `planRefresh`, `runDiscovery` clamps | `discovery_coverage.test.ts`, R3 | TESTED |
| Plan stored atomically | transaction in `planRefresh` | `discovery_planning.test.ts` (6) | TESTED |
| Parent never orphaned by a planning failure | try/catch → `finalizeRefreshRun('failed')` + rethrow | same | TESTED |
| Parent/child states consistent under reaping | conditional finalization, `SKIP LOCKED` claiming | `discovery_reap_race.test.ts` (6) | TESTED |
| Exactly one finalization / one audit effect | `status='running'` predicate everywhere | F1.6/F1.8, F4, R2 | TESTED |
| Task terminal state not overwritable by a late worker | `finishTask` 409 + `status='running'` predicate | `discovery_reap_race.test.ts` | TESTED |
| Crash recovery, operator-triggered | `reapStaleRuns`, dry-run first, reason + audit | `discovery_e2e.test.ts` E-B-D6, F4 §5/§6 | TESTED |
| No run resume after crash | by design; idempotent rerun | rerun assertions in E1 | TESTED |

## 2. Data, identity and evidence

| Requirement | Implementation | Test | Status |
|---|---|---|---|
| One canonical company per domain | unique `domain_norm` | verifier §1 | VERIFIED-BY-SCHEMA |
| Identity collisions never auto-merged | `lib/resolve/conflicts.ts`, `merged_into` untouched | `identity_conflict.test.ts` (4), `resolve.test.ts` | TESTED |
| Name similarity alone does not merge | `normalizeName` suffix handling; conflicts route to review | `resolve.test.ts` | TESTED |
| Observations preserved, evidence append-only | `claim`, `snapshot`; claim updates blocked | `evidence.test.ts`, verifier §4 | TESTED |
| Source provenance attributable | `discovery_record.source_key` (FK to `public.source`) | `discovery_provenance.test.ts` (5) | TESTED |
| Provenance never invented | `attributeNewItem` fail-closed | same | TESTED |
| Identity conflicts reviewable and attributed | M7 + `conflictAttribution` | `identity_conflict.test.ts` | TESTED |
| Registry sources carry LEI, not domains | nullable `domain_norm` | verifier §1 (NULL-aware uniqueness) | VERIFIED-BY-SCHEMA |
| No Reddit / YouTube | source category CHECK (`S-01..S-12`) | verifier §4 negative insert | VERIFIED-BY-SCHEMA |
| Source permission gate fail-closed | `assertSourceEnabled` before any write | `discovery_sources.test.ts` | TESTED |

## 3. Opportunities and counting

| Requirement | Implementation | Test | Status |
|---|---|---|---|
| Per-pipeline stable identity, idempotent | `opportunityKey`, `UNIQUE (pipeline, opportunity_key)` | `discovery_keys.test.ts`, `discovery_opportunities.test.ts` | TESTED |
| No total-opportunity cap | no limit in the write path; verifier §8 | `discovery_routes_security.test.ts` R5 (60 rows) | TESTED |
| Accumulated history preserved across refreshes | `on conflict do nothing`; FK `on delete cascade/restrict` | E1 rerun, dev DB (8 companies, 5 opportunities) | TESTED |
| New eligible vs promoted distinguished | status-grouped projection | `discovery_counters.test.ts` | TESTED (structure) |
| Eligibility content correct | — | — | **BLOCKED (O10)** |
| Counter semantics unambiguous | `unresolved` split + `measures_basis` | `discovery_counters.test.ts` (4) | TESTED |
| Agency vs direct-client separated | schema permits both; app refuses direct-client (409) | `discovery_opportunities.test.ts` | TESTED (structure) — **BLOCKED (O1)** |
| Shortfalls reported, never transferred | `shortfallReport` per pipeline | R4, `discovery_e2e.test.ts` E2 | TESTED |
| Allocations/targets | none invented | — | **BLOCKED (O2/O3)** |
| Eligibility history append-only and readable | M8 + explicit row mapping | `discovery_eligibility_appendonly.test.ts`, `discovery_eligibility.test.ts` | TESTED |
| Eligibility history field mapping (no silent undefined) | explicit `eligibilityHistory` mapping | `discovery_eligibility_appendonly.test.ts` | TESTED |

## 4. Security and operations

| Requirement | Implementation | Test | Status |
|---|---|---|---|
| Server-side auth on every route | `requireOperatorApi` | `discovery_routes_security.test.ts` R1, `auth_session.test.ts` | TESTED |
| CSRF on mutations | `requireSameOrigin` | R2 (+ positive control), E17 | TESTED |
| Session email wins over body actor | `auth.email ?? actorOf(body)` | R6 | TESTED |
| No credentials in client code | build-time check | `tests/auth.test.ts` / `creative_login.test.ts` | TESTED |
| Append-only protections at DB level | `audit_log`, `claim_assessment`, `opportunity_eligibility` | F3 suite + verifier §6 | TESTED |
| Unprivileged role denied everywhere | RLS + `REVOKE` | verifier §5/§7, F3 §5 | TESTED |
| Schema verification covers Discovery | verifier §6–§8 | executed on dev + pristine scratch | VERIFIED-BY-SCHEMA |
| Malformed path ids refused | uuid guards | `discovery_http_contract.test.ts`, R3 | TESTED |
| Manual-only reaping, dry-run first | `reapStaleRuns` | `discovery_reap_race.test.ts` §5 | TESTED |
| No delivery path in schema | absence checks | verifier §3/§6 | VERIFIED-BY-SCHEMA |
| Local backup + isolated restore | earlier phase | `docs/DATABASE_BACKUP_RESTORE.md` | NOT RE-EXECUTED |
| Live GLEIF smoke | opt-in | `tests/gleif.test.ts` (1 skipped by default) | NOT RE-EXECUTED |

## 5. Product boundaries

| Boundary | Enforcement | Status |
|---|---|---|
| Local-only, single operator | auth, no external calls in tests | TESTED |
| No autonomous outreach | no delivery tables/columns/routes; verifier §3 | VERIFIED-BY-SCHEMA |
| No scheduled discovery | no schedule endpoint, no cron | TESTED (absence) |
| No unapproved ML/LLM scoring | deterministic rules only | TESTED (absence) |
| No EIP / VaultForge | absent from schema and code | TESTED (absence) |
| No cap on accumulation | verifier §8 + R5 | TESTED |
| No fabricated eligibility/weights | O-gated content absent by design | TESTED (absence) |
| Phase-2 features not implemented | no Q&P / brief / proposal / outreach code in this patch | TESTED (absence) |

## 6. Part 1 interface and foundation (2026-10-15)

| Requirement | Implementation | Test | Status |
|---|---|---|---|
| Frozen qualification view (42 columns, order, types) | M9 + M14, `v_opportunity_for_qualification_v1` | `qualification_view.test.ts` (9) | TESTED |
| Eligibility NULL until decided (O10 honesty) | latest-decision lateral, no defaults | same | TESTED |
| Suppression derived from existing state only | `company_merged` / `opportunity_archived` | same | TESTED |
| State hash moves exactly with Discovery truth | `lib/qualification/state.ts` | same | TESTED |
| View permission boundary (grant + attribution denial) | column grants minus `last_transition_actor` | same + `qualification_permissions.test.ts` | TESTED |
| Transactional event emission (register/transition/evaluate) | outbox write inside each state transaction | `qualification_events.test.ts` (12) | TESTED |
| No event on failed/illegal change | emission after the state write, inside the txn | same | TESTED |
| Outbox append-only | T-007-variant guard | same | TESTED |
| Claim / duplicate delivery / interruption | `p2.claim_events`, inbox dedup | same | TESTED |
| Out-of-order ack never skips gaps | contiguous-prefix watermark | same | TESTED |
| Idempotent re-ack writes no duplicate audit | pre-update status read | same | TESTED |
| Poison retained as dead letter, counted | `dead` state + `dead_count` | same | TESTED |
| Unsupported payload versions rejected | version gate in `applyClaimedEvent` | same | TESTED |
| Concurrent consumers independent | composite inbox PK (M15) | same | TESTED |
| Phase 2 cannot write/read Discovery directly | zero grants on Discovery tables | `qualification_permissions.test.ts` (6) | TESTED |
| Inbox/watermark only via the two functions | no direct write grants | same | TESTED |
| Unprivileged role denied the interface | no grants + RLS | same + verifier §10 | TESTED |
| Backfill idempotent (pre-outbox + undelivered) | `backfillCases` + snapshot dedup | `qualification_reconcile.test.ts` (10) | TESTED |
| Drift flagged, never auto-cleared; orphans reported | `reconcileCases` | same | TESTED |
| Replay from retained rows only | `replayCase` | same | TESTED |
| Reference versions registered, retired refused | `reference_version` lifecycle | same | TESTED |
| Case workflow edges + audit | `setCaseStatus` | same | TESTED |
| Transactional idempotency (replay/refuse/rollback) | `withIdempotency` | same | TESTED |
| Manual-only consumption | no scheduler primitives (scan test) + operator script | same + `scripts/qualify.mjs` (executed) | TESTED |
| Interface/p2 schema verified canonically | verifier §9–§10 | `db.mjs verify` on dev + scratch | VERIFIED-BY-SCHEMA |

## 7. Part 2 qualification engine (2026-10-15)

| Requirement | Implementation | Test | Status |
|---|---|---|---|
| Versioned policy/catalog/rubric/capacity schemas + validation | `lib/qualification/policy.ts`, M17 tables | `qualification_policy.test.ts` (10) | TESTED |
| Draft never active; publication explicit; blocked never listed | draft/publish split + `approvedServices` | same | TESTED |
| No approved production content (O-gated) | zero active versions on dev; fixtures test-only | assess-refusal + route 409 | TESTED |
| Evidence bundle from stored rows; duplicates collapse | `lib/qualification/evidence.ts` | `qualification_evidence.test.ts` (9) | TESTED |
| Unapproved excluded; low-confidence labelled; expired/suppressed out | trust registry + freshness rules | same | TESTED |
| Contradictions represented; ambiguity overrides; negatives recorded | polarity links + conflict check + `recordNegativeFinding` | same | TESTED |
| No network path in evidence module | absence by construction | static scan test | TESTED |
| 7 gates pure + precedence + suppression absolute | `lib/qualification/gates.ts` | `qualification_gates.test.ts` (10) | TESTED |
| Pairwise failure precedence deterministic | policy-order primary | pairs + spot checks | TESTED |
| Pure `score()` with versioned inputs + as_of | `lib/qualification/scoring.ts` | `qualification_scoring.test.ts` (10) | TESTED |
| Missing→null never favourable; coverage veto; bands policy-gated | null-exclusion + minCoverage | same | TESTED |
| Weight-scaling invariance; replay determinism; monotonicity | normalized weights; input hash | same | TESTED |
| Capacity order-only; timing decay; no probability language | pursuit split; decay fn; output scan | same | TESTED |
| Anti-signals zero fit with flag | family-matched disqualifiers | same | TESTED |
| Lexicographic ranking + floors-first + explainer + snapshots | `lib/qualification/ranking.ts` | `qualification_ranking.test.ts` (4) | TESTED |
| Research tasks ordered, idempotent, operator-worked | `lib/qualification/research.ts` | same | TESTED |
| Immutable assessments + all-inputs idempotency + staleness | `lib/qualification/assessments.ts` | `qualification_assessments.test.ts` (10) | TESTED |
| Inactive references refuse before any write | active-check gate | same | TESTED |
| Qualification routes (assess/cases/detail/task) authed + CSRF | 4 routes | `qualification_routes.test.ts` (6) | TESTED |
| Operator commands incl. assess with fail-closed defaults | `scripts/qualify.mjs` | executed (status/backfill/assess-refusal) | TESTED |

## 8. Part 3 lifecycle, review, research, UI, evaluation (2026-10-15)

| Requirement | Implementation | Test | Status |
|---|---|---|---|
| Lifecycle states on canonical vocabulary (no duplicates) | `p2.case_decision` + derived display states | `qualification_decisions.test.ts` (10) | TESTED |
| Legal transitions + reasons, backend-enforced | `decide()` rule chain | same | TESTED |
| Decisions cite exact assessment+snapshot; immutable; corrections cite new | unique (case, assessment) + append-only | same | TESTED |
| Suppression/hard-gate never overridden; stale refused | pre-decision checks | same | TESTED |
| Concurrent decisions conflict (409) | partial unique index | race test | TESTED |
| Exclusion mid-assessment aborts recording | `assertAssessmentCurrent` wired pre-record | guard unit + steady-state | TESTED |
| Reconsideration/withdrawal audited; deferral policy-limited | decision types + policy.deferral | same | TESTED |
| Deferral resume conditions schema-required | M18 CHECK | schema refusal test | TESTED |
| Manual research tasks + due flags + workflow | `createResearchTask`, `setResearchTaskDue`, PATCH route | lifecycle-routes suite (6) | TESTED |
| DoneFound/DoneNoneFound/Expired derived, frozen statuses kept | read-time derivation | case detail + research page | TESTED (display) |
| Ranked queue: filters/sort/totals, suppressed hidden, missing as — | `/qualification` + `qualificationQueue` | routes + build | TESTED (logic) |
| Case detail: all §4 sections, escaped content, safe URLs | `/qualification/cases/[id]` | build + lib suites | TESTED (logic) |
| Assess console, research workspace, policy/capacity, audit, admin, today | 8 pages + nav (no orphans) | `dashboard.test.ts` nav inventory + build | TESTED |
| Reconcile/backfill triggers + drift preview | routes + admin panel | lifecycle-routes suite | TESTED |
| Evaluation harness + versioned gold set + baselines | `lib/eval/*`, `eval/goldset.v1.json`, `scripts/evaluate.mjs` | `evaluation.test.ts` (9) | TESTED |
| Metrics with denominators + pre-declared thresholds + unmeasured named | harness + generated report | same | TESTED |
| Adversarial regressions (injection/unsafe URLs/scripts/races) | gold adversarial items + static scans | same | TESTED |
| Pilot readiness assessed, not activated | `PILOT_READINESS_REPORT.md` → BLOCKED | n/a (report) | DOCUMENTED |