# GRAYSCALES DISCOVERY — PRIORITIZED FINDINGS REGISTER

> **Date:** 2026-10-15. Supersedes the inline finding lists in earlier reports
> (those remain as audit records). Every status below is backed by executed
> evidence named in the "Evidence" column.
>
> Legend: **FIXED** · **DOCUMENTED** (truthfully described, no code change) ·
> **BLOCKED** (needs an owner decision — not guessed) · **OPEN** (known,
> deliberately deferred)

## A. Closed in this gate

| ID | Finding | Priority | Status | Evidence |
|---|---|---|---|---|
| F3 | Eligibility history not append-only at the DB level | integrity | **FIXED** | M8 `20261014190008_eligibility_append_only.sql`; `discovery_eligibility_appendonly.test.ts` (5) + executed negative control |
| F4 | Reaper vs in-flight worker: terminal states, duplicate finalization | concurrency | **FIXED** | `discovery_reap_race.test.ts` (6); `readRunStatus`; reaper `status='running'` predicate |
| F5 | `planRefresh` stored a partial plan on mid-loop failure | integrity | **FIXED** | `discovery_planning.test.ts` (6); negative control leaked 1–2 rows without the transaction |
| F6 | Parent run left `running` when planning threw | integrity | **FIXED** | Same file: parent `failed` with reason, 0 tasks, 0 child runs |
| F7 | `unresolved` conflated reviewable records with unfinished tasks | semantics | **FIXED (additive)** | `unresolved_opportunities` / `unresolved_tasks` + unchanged `unresolved`; `discovery_counters.test.ts` |
| F8 | Historical `new_eligible` changes when an opportunity is promoted | semantics | **DOCUMENTED** | `measures_basis: "live_projection"` on every summary; promotion test asserts the live/frozen split |
| F9 | Can a caller supply an arbitrary actor label? | security | **VERIFIED** (route actor precedence holds) / **BLOCKED** (service-identity policy) | `discovery_routes_security.test.ts` R6; `B-D13` |
| F10 | Identity-conflict capture has no actor | audit | **DOCUMENTED + exposed** | `conflictAttribution()` + test; no column added on purpose (redundant, and freezes a caller-supplied label) |
| F11 | Verifier ignores the Discovery schema | integrity | **FIXED** | `t002_verify.sql` §6/§7/§8 — executed on dev and on a pristine scratch database |
| F12 | Reports stale | truthfulness | **FIXED** | Correction block in `DISCOVERY_READINESS_REPORT_PROMPT5.md`; executed totals in the final report |
| F13 | `"unknown-source"` fabricated provenance | integrity | **FIXED** | `attributeNewItem()` fail-closed; `discovery_provenance.test.ts` (5); 0 affected rows in either DB |
| F14 | Five API routes had no security/contract tests | security | **FIXED** | `discovery_routes_security.test.ts` (20) |
| F15 | Login asset licence status unrecorded | legal | **DOCUMENTED** (owner confirm open) | `public/creative-login/PROVENANCE.md` §Licensing; no asset edited |
| F16 | `app/agencies/loading.tsx` deletion impact undocumented | correctness | **DOCUMENTED** | Already pinned by `creative_login.test.ts` (no `loading.tsx` anywhere under `app/`) |
| F17 | Dev-database verify failed on a pristine-count assertion | truthfulness | **FIXED** (identity-based verification; **no data deleted**) | `node scripts/db.mjs verify` → `verify ok` on dev with 8 live companies |

## B. Open — product decisions (owner)

| ID | Finding | Why it is not a code fix | Status |
|---|---|---|---|
| F18 | Run-event counters are live projections, not a frozen record | Freezing them requires new snapshot rows and a retention policy — a product decision (relates to O3, D-008). Recommendation recorded in the final report §F8. | **BLOCKED** |
| F19 | Reaper has no heartbeat; a slow healthy run can be reaped | A heartbeat is new infrastructure (and new rows); the operator threshold is the current, deliberate design. | **OPEN** |
| F20 | Service-identity policy undefined for bearer credentials | Defines who a machine credential claims to be. Inventing it would be a security-policy guess. `B-D13`. | **BLOCKED** |
| F21 | A late worker may still attach `child_run_id` to a reaped task | Deliberate: provenance for data the child already committed. Only `child_run_id` is touched; status/note/yields stay the reaper's. Pinned by test. | **DOCUMENTED** |
| F22 | No run-resume after a crash | Approved as out of scope (idempotent rerun instead). | **OPEN** |
| F23 | Single-active-run policy undecided | Concurrent refreshes are permitted today and must stay permitted without an owner decision. | **BLOCKED** |

## C. Known limitations (unchanged, previously documented)

| ID | Limitation |
|---|---|
| L1 | DNS rebinding / TOCTOU in the SSRF guard (`fetch-guard.ts`) — structurally mitigated, not provably airtight. |
| L2 | Retention windows not implemented (D-008): no purge job exists, by design. |
| L3 | Only one live adapter (GLEIF). Directory sources exist as a deterministic fixture only. |
| L4 | GLEIF-sourced companies have `domain_norm = NULL` — identity is the LEI. Consumers must handle a null domain. |
| L5 | `new_evidence` is 0 for fixture-sourced refreshes because fixture records carry no registry id, so no identity claim is generated (correct behaviour, easy to misread as a bug). |
| L6 | Direct-client pipeline refused at the application layer (409) while the schema permits the value (O1). |
| L7 | No automated outreach, no delivery path, no scheduler, no ML/LLM scoring — enforced by schema and tests. |

## D. Severity ladder used for prioritization

1. Data integrity / silent data loss
2. Concurrency and terminal-state correctness
3. Migration safety and reversibility
4. Authorization, CSRF, attribution
5. Truthful run-state and counter reporting
6. Contract completeness and documentation freshness
7. Everything else

---

# PART 1 ADDENDUM (2026-10-15) — interface and foundation findings

All P1 items below were found by execution during Part 1 (each observed
failing before its fix) and are closed. Owner-side items they raised were
recorded as B-D13/F18, not guessed.

| ID | Finding | Priority | Status | Evidence |
|---|---|---|---|---|
| P1-1 | No durable Discovery→Phase 2 event stream existed | integrity | **FIXED** | M9 outbox + transactional emission; `qualification_events.test.ts` |
| P1-2 | `claim_events` failed every call (arbiter/variable ambiguity, twice) | correctness | **FIXED** | M11 then M12; direct-execution proof before/after |
| P1-3 | First claim by a new consumer returned nothing (NULL watermark) | correctness | **FIXED** | M13 one-line default; probe + suite |
| P1-4 | Second consumer starved by global inbox PK | concurrency | **FIXED** | M15 composite PK; two-consumer test with independent watermarks |
| P1-5 | `last_event_sequence` arrived as text, violating the integer contract | correctness | **FIXED** | M14 cast + re-issued grants; view contract test |
| P1-6 | p2_app's granted writes RLS-denied (enabled RLS, no policy) | security | **FIXED** | M16 policies for exactly the granted surface; permission suite |
| P1-7 | Pool-starvation deadlock from `pool.query` on a hot conflict path | concurrency | **FIXED** | same-client select; 8×60s timeouts → 9/9 in 2.2s |
| P1-8 | Registration's two writes auto-committed separately | integrity | **FIXED** | transaction around row + audit + event |
| P1-9 | `registerOpportunity`'s conflict-path select briefly used a second pool checkout (reverted as part of P1-7) | concurrency | **FIXED** | same change as P1-7 |

---

# PART 2 ADDENDUM (2026-10-15) — qualification engine findings

All P2 items were found by execution during Part 2 (each observed failing
before its fix) and are closed. No owner content was invented to close any of
them: production has no active policy/catalog/rubric/capacity versions, and
the assess path refuses without them.

| ID | Finding | Priority | Status | Evidence |
|---|---|---|---|---|
| P2-1 | Polarity queried the wrong table (`claim_evidence` links claims-to-claims; contradiction links live on `hypothesis_evidence`) — every claim would have read as contextual | integrity | **FIXED** | schema inspection + contradiction tests in `qualification_evidence.test.ts` |
| P2-2 | Best-fit accumulator initialized at 0 with `>` comparison: a 0-score anti-signal zeroing could never be selected | correctness | **FIXED** | `consider()` with empty start + first-wins ties; anti-signal test |
| P2-3 | Assessment staleness compared incompatible hashes (score input-hash vs Discovery state-hash): every fresh assessment read stale | correctness | **FIXED** | `snapshot_hash` column now stores the state hash; score hash stays in JSON |
| P2-4 | Post-insert UPDATE for reproducibility columns tripped the append-only guard (own guard working as designed) | integrity | **FIXED** | columns ride the INSERT via extended `AssessmentInput` |
| P2-5 | Test-built "unknown country" via empty string violated `company_country_check` — the real unknown case is an opportunity with no company | semantics | **FIXED (test)** | jurisdiction-unknown test via company-less opportunity |
| P2-6 | Stale-gate test used a fresh claim among old ones (pass was correct, expectation wrong) | semantics | **FIXED (test)** | all-stale fixture |

---

# PART 3 ADDENDUM (2026-10-15) — lifecycle, review, UI, evaluation findings

| ID | Finding | Priority | Status | Evidence |
|---|---|---|---|---|
| P3-1 | Suppression-vs-staleness check order: archiving after assessment reported `stale_assessment`, hiding the actionable suppression fact | correctness | **FIXED** | suppression checked first in `decide()`; suppression test |
| P3-2 | Deferral-lifetime test hit the structural active-check before the numeric limit (test sequencing) | semantics | **FIXED (test)** | restructured: close first deferral, then exhaust lifetime |
| P3-3 | `rankLeads` accumulator duplicated after edit (compile break, caught by tsc) | correctness | **FIXED** | removed duplicate; ranking suite |
| P3-4 | Evaluation cleanup used case-sensitive LIKE on lower-cased keys — rows survived and blocked company deletion | integrity | **FIXED** | ILIKE patterns in `cleanupGold`; manual residue cleared |
| P3-5 | Queue/ranking/harness had no suppression exclusion: a stale rank could list a suppressed opportunity | integrity | **FIXED** | pool-level exclusion in harness + `hideSuppressed` default in queue + `suppressed` input in `rankLeads` |