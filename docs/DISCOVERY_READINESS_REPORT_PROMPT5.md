# DISCOVERY READINESS REPORT — PROMPT 5

> **SUPERSEDED IN PART — read this first (added 2026-10-15).**
> This report is an audit record of the Prompt 5 session and is preserved
> **unaltered below**. Its test totals (31 files / 354 tests) were accurate for
> 2026-10-14 and are **stale**; the executed totals as of the completion gate
> are in `docs/GRAYSCALES_DISCOVERY_FINAL_VERIFICATION_REPORT.md` §8.
> Later work: F3/F4 hardening, then the completion gate that fixed planning
> atomicity (F5/F6), provenance fail-closed behaviour (F13), API route security
> coverage (F14), counter-semantics labelling (F7/F8), and identity-based schema
> verification covering the Discovery structures (F11/F17). Findings are now
> tracked in `docs/GRAYSCALES_DISCOVERY_FINDINGS_REGISTER.md` and traceability in
> `docs/GRAYSCALES_DISCOVERY_TEST_TRACEABILITY.md`.

> Date: 2026-10-14 · Scope: Discovery UI integration, end-to-end testing, readiness.
> Verdicts below distinguish **implementation completion**, **local operational
> readiness**, **formal validation readiness**, and **external deployment
> readiness** — they are not the same claim.
>
> Every number in §4–§6 comes from a command run in this session. Checks that
> were not executed are named as such; none are marked passed.

---

## 1. Executive summary

Prompt 5 completed the Discovery integration on top of Prompt 4's persistence
and lifecycle layers: manual refresh (API + planner UI), the accumulated
opportunity collection with filters/pagination/detail, a source-permission gate,
operator-triggered crashed-run recovery, and identity-conflict capture. The
backend was audited before the UI was built, and that audit plus first-ever
execution of Prompt 4's code surfaced **three real defects** — one of which
silently defeated the whole refresh-to-opportunity pipeline. All three are
fixed and covered by tests that now execute against a real PostgreSQL.

The Discovery feature is **structurally complete and verified locally**.
It is deliberately **not semantically complete**: what counts as an eligible
new opportunity, how the target is allocated across pipelines, what the
eligibility rules say, and whether a direct-client pipeline exists are owner
decisions (O1–O3, O10) that remain OPEN, so the system reports honest counts
and shortfalls instead of invented policy.

## 2. Implementation verdict

| Dimension | Verdict | Basis |
|---|---|---|
| Discovery implementation | **COMPLETE** | All Prompt 4–5 scope built and exercised (§4). O-gated behavior deliberately refused, not stubbed. |
| Local operational readiness | **CONDITIONAL** | Everything green locally (§5), but: no off-host backup custody, no heartbeat for run liveness, MFA and persistent rate limits still deferred, Docker-dependent operations documented as single-machine. |
| Formal validation readiness | **BLOCKED** | T-014 §12(a)–(e) approvals, independent ground truth, and approved validation thresholds do not exist. R-05 stays OPEN. |
| External deployment | **NOT AUTHORIZED** | Local-only by design; no deployment, no cloud resources, no external exposure. |

## 3. Files and migrations changed

**Migrations (7 new, all additive, applied to dev + `agency_intel_test`; total 33)**

| ID | File | Purpose |
|---|---|---|
| M1 | `db/migrations/20261014190001_coverage_tasks.sql` | per-task coverage ledger + child-run link |
| M2 | `20261014190002_opportunity_identity.sql` | `opportunity`, `business_relationship` (multi-opportunity per business; RESTRICT everywhere) |
| M3 | `20261014190003_eligibility_versions.sql` | append-only versioned eligibility decisions |
| M4 | `20261014190004_brief_policy_snapshot.sql` | nullable `brief.policy_version` |
| M5 | `20261014190005_opportunity_run_link.sql` | `opportunity.run_id` (refresh-level counting from stored rows) |
| M6 | `20261014190006_coverage_task_plan_order.sql` | `plan_seq` + `created_at` + FIFO index (fixes a real claim failure) |
| M7 | `20261014190007_identity_conflict.sql` | identity-conflict review artifact |

**Libraries:** `lib/discovery/{keys,opportunities,coverage,eligibility}.ts`
(Prompt 4), `lib/discovery/{refresh,sources,reap}.ts` (Prompt 5),
`lib/resolve/conflicts.ts` (Prompt 5).
**API:** `app/api/discovery/refreshes/route.ts`,
`app/api/discovery/refreshes/[id]/route.ts`, `app/api/discovery/reap/route.ts`,
`app/api/opportunities/route.ts`, `app/api/opportunities/[key]/route.ts`; extended
`app/api/discovery/runs/[id]/route.ts`.
**UI:** `app/opportunities/page.tsx`, `app/opportunities/[key]/page.tsx`,
extended `app/discovery/page.tsx`, `components/refresh-plan-form.tsx`,
`components/reap-runs-form.tsx`, `lib/dashboard/nav.ts` (Opportunities entry).
**Tests:** `tests/discovery_e2e.test.ts` (15), `tests/discovery_sources.test.ts` (8),
`tests/identity_conflict.test.ts` (3), `tests/discovery_http_contract.test.ts` (2),
extended `tests/discovery_{keys,opportunities,coverage,eligibility}.test.ts`,
`tests/gleif.test.ts` (conflict case), `tests/seed.test.ts` (MIGRATION_COUNT 33).

## 4. Requirement → code → test traceability (Prompt 5 §2/§4)

| Mission item | Implementation | Evidence |
|---|---|---|
| 2A overview (runs, opportunities, coverage, shortfall, evidence, permissions) | `app/discovery/page.tsx` + `refreshSummary` | Browser screenshots; live refresh payload |
| 2B manual refresh, no duplicate active runs, progress + final status, safe reload | `refresh-plan-form.tsx`, `POST /api/discovery/refreshes` | E1; live run + idempotent re-run (5 duplicates, 0 new) |
| 2C full accumulated collection, nothing hidden | `/opportunities` + `/api/opportunities` | E15/E16 pagination-overlap assertions; live 5-record collection |
| 2D evidence/decision detail, observed vs inferred | `/opportunities/[key]` | Browser render: evidence + provenance + eligibility (0, honest) + lifecycle attribution |
| 2E approved review actions only | `decideIdentityConflict` (reviewed/deferred + reason + audit) | `identity_conflict.test.ts` |
| 4.1 complete refresh | `runRefresh` | E1 (executed) |
| 4.2 < 50 with shortfall, no padding/transfer | `shortfallReport` | E2: shortfall row `{target 50, actual N, shortfall 50-N}` |
| 4.3 ≥ 50 controlled fixtures | registry + lib | E3: 60 rows counted exactly once |
| 4.4 duplicates do not inflate | unique keys + child-run join | E4 + live re-run (duplicates 5, new 0) |
| 4.5 promotions are not new | separate `promoted` bucket | E4/E5; `linkPromotion` concurrency test |
| 4.6 new evidence preserves history | append-only claims | E6 (two observations, two claims) |
| 4.7 multiple opportunities per business | no per-company uniqueness | E7 (3 opportunities on 1 company) |
| 4.8 ambiguous identities never auto-merged | D-011 rules + M7 capture | E7 + `identity_conflict.test.ts` + gleif conflict case |
| 4.9 pipelines distinct | `registerOpportunity` refuses `direct_client` | E9 (409 `direct_client_blocked`) |
| 4.10 contradictions / freshness | evidence ledger statuses | E10 (contradicting link persisted) |
| 4.11 disallowed sources / revoked permission refused | `lib/discovery/sources.ts` gate | E11: disabled source → run refused pre-write; refresh task failed with `[source_disabled]`; re-enable restores |
| 4.12 unsafe redirects / private destinations | existing `fetch-guard.ts` (SSRF denylist) | Untouched this session; T-006 tests green |
| 4.13 timeouts / rate limits / retries / partial failure | adapter contract + task ledger | E-partial: unknown adapter → task failed, `endState: failed` |
| 4.14 repeated + concurrent idempotency | uniques + SKIP LOCKED + transaction checks | E14: 2 concurrent refreshes, bounded growth |
| 4.15 history across refreshes | append-only runs/items | E1 (rerun keeps prior runs addressable) |
| 4.16 pagination/filters omit nothing | totals + overlap assertions | E15 |
| 4.17 auth / authz / CSRF / audit | guards unchanged; new routes follow them | Anonymous 401s, no-Origin 403, attributed lifecycle row |
| 4.18 backup + isolated restore | `scripts/backup.mjs` | backup → verify → scratch restore (integrity: 33 migrations, 12 categories, 0 orphan claims) |

**Synthetic vs real:** all `fixture-*` / `de2e-*` / `dconf-*` data is synthetic and
labeled as such in the tests. The single live GLEIF refresh in §6 used real
public registry data and is reported as a *bounded smoke*, not as discovery
performance.

## 5. Actual regression results (commands run, this session)

| Check | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` | clean (run after every code change; last run clean) |
| Production build | `npm run build` | ✓ Compiled successfully (29.7 s, clean `.next` rebuild) |
| Migrations (dev) | `node scripts/db.mjs migrate` | 7 applied, total 33 |
| Migrations (test) | `node scripts/db.mjs migrate --target test` | 7 applied, total 33 |
| Seed idempotency | `node scripts/db.mjs seed` ×2 | `seed ok` ×2 |
| Schema verification | `node scripts/db.mjs verify` | `verify ok: db/tests/t002_verify.sql` |
| Full suite | `npx vitest run` | **31 files / 354 passed / 1 skipped** (skip = live GLEIF smoke, opt-in; run separately and passed) |
| Live GLEIF smoke | `GLEIF_LIVE_SMOKE=1 npx vitest run tests/gleif.test.ts -t "live smoke"` | passed |
| Backup | `node scripts/backup.mjs backup --target=prompt5` | 142,908 bytes + manifest |
| Restore | `node scripts/backup.mjs verify <dump>` / `restore <dump> --scratch prompt5_scratch` | sha256 match, 256 TOC entries; restore ok, integrity ok, scratch dropped |
| Lint | — | **no lint script configured** (`package.json` has typecheck, not lint). Not claimed. |

**Dev database state changed on purpose:** the live GLEIF refresh (§6) added 5
real agencies, 5 registry observations, 5 opportunities and 2 runs to the dev
database. That is real operator use of the feature; the rows were kept as
evidence rather than deleted to make a test pass.

Not executed: provider-run CI (no remote runner exists), off-host backup
verification (no off-host destination), MFA/persistent rate-limit tests
(features deferred), and load/perf testing at new scales.

## 6. Counting and data-integrity verification

**Live proof over HTTP against a production build** (bounded smoke, real
public GLEIF data, not a performance claim):

- `POST /api/discovery/refreshes` with one GLEIF task →
  `{status ok, tasksPlanned 1, tasksDone 1, endState exhausted, measures
  {new_eligible 0, new_evidence 5, duplicates 0, unresolved 5}}`.
  Zero "eligible" is the honest state while O10 is open.
- The **same** plan re-run → `{new_evidence 0, duplicates 5, unresolved 0}`:
  duplicates do not inflate counts and history was appended, not rewritten.
- `GET /api/discovery/refreshes/<id>?target_agency=50` → shortfall row
  `{target 50, actual 0, shortfall 50}` — no padding, no cross-pipeline
  transfer.
- Disabling a source row and re-enabling it (E11) → runs refused pre-write,
  then restored.
- Malformed id → 422; unknown id → 404; anonymous → 401; cookie POST without
  Origin → 403.

- **Counters are separate and documented** (RUNBOOK §5d): run outcomes
  (frozen), task ledger (frozen), refresh measures (live opportunity states),
  evidence count, duplicates, shortfall, collection total. The UI states the
  frozen-vs-live distinction so a re-evaluation cannot silently rewrite history.
- **`new_eligible` is a lifecycle status count, not a judgment.** With O10
  undecided, opportunities stay `observed`; the live refresh honestly reported
  `new_eligible: 0, unresolved: 5`. No eligibility content was invented.
- **Promotions never count as new** (`promoted` is its own bucket; the
  promotion is recorded once, and concurrent double-promotion resolves to the
  existing link rather than a 409 race).
- **Shortfall rows are per-pipeline and never transferred**; targets are
  caller-stated because no allocation is approved (O2).
- **Integrity invariants re-proven on restore:** 33 migrations present, 12
  source categories, zero orphan claims; `source.enabled` gate proven by
  toggling the row; conflict capture proven to create no company and no merge.

## 7. Defects found and fixed (all found by executing, none masked)

1. **`claimTask` ordered by a column that did not exist** (Prompt 4). Every
   planned refresh failed on first claim. Fix: additive M6 (`plan_seq` for
   deterministic FIFO + `created_at`) + index.
2. **Unsound cast in `runDiscovery`**: pg rows (snake_case) cast to
   `RunItemResult` (camelCase), so `companyId` was `undefined` for every item
   and the refresh registered **zero** opportunities. One existing test passed
   vacuously as a result. Fix: explicit mapping; the declared type is now the
   contract.
3. **Identity conflicts were counted and dropped.** A record colliding with a
   canonical company produced a `conflict` count, a note, and no review
   artifact — the source's identity attributes were lost, and `match_candidate`
   could not represent them without creating a company (i.e. pre-deciding a
   merge). Fix: M7 + `lib/resolve/conflicts.ts` + run capture + UI + audit.
4. **Two coverage tests asserted unreachable states** (mid-plan stop rules
   after the queue was exhausted, contradicting the blueprint's precedence).
   Tests corrected to keep a pending task; assertions strengthened.
5. **Malformed path ids produced a raw 500.** Fixed with uuid guards (422) on
   both `[id]` routes, covered by a contract test and a live check.
6. **Defense-in-depth hardening** (from the pre-execution audit): actor
   required on every opportunity writer; coverage tally uses an explicit
   status allowlist; eligibility version-number races retry once; redundant
   index dropped; task notes keep machine-readable error codes.
7. **A test that measured the wrong thing.** `tests/seed.test.ts` asserted the
   dev database held exactly 3 companies / 5 claims / 1 hypothesis. That is
   only true while dev is frozen; the live refresh in §6 legitimately added
   real agencies, so the assertion failed on a correct system. It now asserts
   the seeded records **by identity** (ids, names, domains, their claims and
   the `needs_review` hypothesis) — a stronger invariant that also proves the
   dev seed is untouched. Disclosed because a test assertion was changed:
   nothing was weakened, and the discovery rows were deliberately kept.

## 8. Security and source-permission findings

- New routes use the same guard stack as the rest of the app: operator session,
  CSRF origin check on mutations, actor attribution, one error shape. Verified
  live: anonymous 401, missing-Origin 403, bodyless POST 400.
- **Permission is now enforced, not documented**: `public.source.enabled` is the
  sole run gate (amendment §4F). Unknown sources fail closed. Disabling a
  source blocks new runs before any write; existing history is untouched.
- Untrusted source content is escaped by React; external URLs are validated to
  http(s) before becoming links; error responses never include internal
  details (invalid uuid → 422 with a fixed message, not a driver error).
- SSRF guard, rate limiting, and the no-auto-merge rules are unchanged from
  T-006/T-004 and remain covered by their existing tests.
- Residual risk (unchanged, previously recorded): single operator account, no
  MFA, login throttling is in-memory (lost on restart), and the legacy bearer
  token remains a documented service credential when configured.

## 9. Operational documentation

`docs/RUNBOOK.md` now documents, for this feature: §5b manual refresh
(planning, status, shortfall reading, failure recovery, reaping, permission
refusals), §5c identity conflicts (capture, reading, deciding, and why they
never merge), §5d the distinct counters with their sources, plus the existing
startup/shutdown, backup/restore, health, and incident-triage sections.
Cloud provisioning is absent by design and no off-host custody is claimed.

## 10. Remaining owner decisions (nothing below was decided here)

| ID | Decision needed | Consequence of leaving it open |
|---|---|---|
| O1 | Direct-client pipeline in or out of scope | `direct_client` rows refused (409); UI shows the pipeline as empty |
| O2 | Pipeline allocation of the target | No default split; shortfall rows are per-pipeline only |
| O3 | Counting measures and the target's basis | Structure only; `new_eligible` is a lifecycle status count |
| O4 | Planner scope (task lists, low-yield N, caps) | Thresholds are caller-stated; no defaults exist |
| O10 | Eligibility criteria per pipeline | No canonical gates; evaluations require an explicit policy version |
| O11 / T-014 §12(a)–(e) | Sample plan, D-004/005 posture, QA assignee, weights acceptance, labor | Formal pilot cannot start |
| D-004/005/006/008 | Capability catalog, pricing, weights, retention | Downstream phases remain blocked |
| R-05 | QA attestation + criteria | Stays OPEN |
| B-D1 | `.docx` spec supply or written confirmation that brief + repo are canonical | No claim of spec compliance |

## 11. Known limitations

- No run heartbeat: reaping relies on an operator-stated threshold; too short a
  threshold can close a healthy slow run (hence dry-run first).
- `new_evidence` counts claims created inside the run window for the refresh's
  companies — an attribution window, not a per-record join.
- Opportunity search is bounded substring matching (no trigram index on
  opportunities).
- One planned refresh runs synchronously in request scope; a long plan is
  bounded by adapter limits, not by a job queue (no queue was added).
- `observed_at` is not populated for registry observations created by
  discovery runs, so the evidence table shows "—" rather than inventing a date.
- `/review` does not yet surface identity conflicts as a queue source (they are
  visible on the run detail page and via API); adding a tenth queue source is a
  separate decision.
- Duplicate identical tasks within one plan are executed twice — de-duplication
  policy belongs to O4.

## 12. Recommended next phase

1. **Owner decision session** on O1–O4 and O10 — everything else is blocked
   behind them, and the refusal paths are already in place so nothing breaks
   when they land.
2. **Supply or confirm B-D1**, then re-check traceability against the canonical
   spec.
3. **Operational hardening** (small, evidence-driven): run heartbeat so reaping
   stops depending on a guessed threshold; opportunities search index if the
   collection grows; explicit lint script in CI.
4. Only then: T-014 per its protocol, with independent ground truth.

---

## Exit criteria

- **DISCOVERY IMPLEMENTATION: COMPLETE** — Prompt 4 + Prompt 5 scope built and
  exercised; O-gated behavior refused rather than guessed.
- **LOCAL OPERATIONAL READINESS: CONDITIONAL** — full suite/build/migrations/
  seed/verify/backup/restore green and a live manual refresh proven over HTTP
  on a production build; conditional on documented single-machine limits, the
  absence of off-host backups and heartbeat-based liveness, and deferred
  MFA/persistent throttling.
- **FORMAL PILOT: BLOCKED** — T-014 not started; §12(a)–(e) approvals,
  independent ground truth, and approved thresholds do not exist; R-05 OPEN.
- **EXTERNAL DEPLOYMENT: NOT AUTHORIZED** — local-only tool; nothing deployed,
  no cloud resources provisioned.
- **Actual verification evidence:** §5 tables (executed commands and results).
  Checks not executed are named in §5 and §11; none are reported as passed.

**No next phase was started. Awaiting owner review.**