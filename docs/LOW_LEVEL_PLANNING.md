# LOW_LEVEL_PLANNING — Atomic Tasks

> Each task independently reviewable. IDs stable (`T-001…`). Mark PROPOSAL file paths (repo currently empty).

## Conventions

Fields: Objective · Prerequisites · Likely files/modules · Expected result · Verification · Acceptance · Risks.

---

### T-001 — Scaffold docs + decision triage (this phase)

- Objective: complete `AGENTS.md`, `agents/`, `docs/` set + consistency audit.
- Prerequisites: workspace audit.
- Files: `AGENTS.md`, `agents/**`, `docs/**`.
- Result: 22 files created; audit checklist passes.
- Verification: file inventory + link check (run link checker; report output).
- Acceptance: master prompt §14 all checked.
- Risks: scope drift in docs → mitigate via spec-wins rule.

### T-002 — Data model migration + seeds (P1) — COMPLETE 2026-10-13

- Objective: implement schema per `DATA_MODEL_AND_EVIDENCE.md` (agency company with PROPOSAL `agency_type`/`country`/`region` fields per spec §2, snapshot, claim, hypothesis, catalog, brief, outcome, audit).
- Prerequisites: D-001/D-002 decided (worldwide agencies — no single-country gating); D-007 (import limits).
- Files: `db/migrations/*` (ordered SQL, source of truth; applied by `scripts/db.mjs`), `db/seed.sql` (deterministic synthetic seed), `db/tests/t002_verify.sql` (assertion suite).
- Result: migrations apply cleanly on fresh Docker PostgreSQL 17.11 via the runner (verified: bootstrap + migrate + seed + SQL suite); seeds load.
- Verification: `db reset` + psql assertion suite — 6/6 DO blocks pass; dup domain + dup registry rejected live; audit/snapshot immutability enforced live; RLS+REVOKE denial for anon/authenticated live; seed rerun idempotent. See `DATA_MODEL_AND_EVIDENCE.md` §10.
- Acceptance: duplicate-domain/registry insert rejected ✓; audit append-only enforced ✓ (for granted roles; owner limitation documented).
- Risks: TBD schema choices → keep behind PROPOSAL flags.

### T-003 — Manual entry + CSV import (P1) — COMPLETE 2026-10-13

- Objective: FR-001/FR-002 with per-row validation report + duplicate preview.
- Prerequisites: T-002 ✓ (re-verified intact: T-002 suite 6/6 after T-003 reset).
- Files: `lib/intake/*` (normalize/validate/csv/import/db/http), `app/api/companies`, `app/api/imports[/[id][/confirm]]`, `app/import/page.tsx`, `db/migrations/20261013000001_import_staging.sql`, `tests/*.test.ts`.
- Result: manual create (201/409/422) + CSV preview → explicit confirm → partial-success commit with row-level reasons; retries/concurrent confirms safe.
- Verification: vitest 53/53 pass (35 unit + 18 integration incl. live-DB duplicate/race/idempotency/RLS checks, 5000-row accept + 5001-row reject); `tsc --noEmit` clean; `next build` clean on Next 15.5.27; no-send-path static test passes.
- Acceptance: FR-001/FR-002 acceptance text met (social-URL-only identity: documented limitation — any syntactically valid domain accepted, ownership unverified).
- Risks: row cap enforced server-side (D-007); operator auth unresolved (local-only use). Next: T-004.

### T-004 — Canonical resolution + dedup (P1) — COMPLETE 2026-10-13

- Objective: FR-003 match keys + review queue + merge/split with audit (deterministic; no fuzzy ML per locked boundaries — name-exact queue instead).
- Prerequisites: T-002, T-003.
- Files: `lib/resolve/*`, `app/api/resolve`, `app/api/candidates*`, `app/agencies/[id]`, `app/resolve`, `db/migrations/20261013000002_resolution.sql` + `...0003_canonical_uniques.sql` + `...0004_snapshot_delete_policy.sql` + `...0005_resolution_evidence.sql`, `tests/resolve.test.ts`.
- Result: deterministic candidates + human-confirmed merges preserve history.
- Verification: 30/30 resolve tests (rules, conflicts, reopen, preview, rollback, concurrency, RLS) + full 92/92 suite + tsc/build clean + HTTP end-to-end (resolve→preview→accept→detail). See `docs/T004_IDENTITY_RESOLUTION_REPORT.md`.
- Acceptance: no duplicate canonical domain/registry ✓ (scoped uniques, live-tested); merges keep history ✓ (rows + aliases + audit, snapshots stay attributed); ambiguous/conflicting cases require human review ✓.
- Risks: none open; domain-ownership verification still out of scope (documented limitation).

### T-005 — Adapter interface + registry (P2) — COMPLETE 2026-10-13

- Objective: FR-005 shared interface, enable/disable, contract tests.
- Prerequisites: T-002; D-003 (priority).
- Files: `lib/discovery/*` (types/registry/fetch-guard/fixtures), `app/api/adapters`, `app/sources` section, `tests/adapters.test.ts`.
- Result: typed contract v1 + deterministic registry + fixture pass contract tests; no live connectors (registry ≠ engine).
- Verification: `tests/adapters.test.ts` + full suite + tsc/build; fixture proves zero network via stubbed-fetch test.
- Acceptance: adapters independently testable/enableable; registration ≠ execution; provenance retained; partial/failed states explicit.
- Risks: none added; live discovery explicitly deferred to individually evaluated tasks.
- Status: verdict in `docs/T005_ADAPTER_REGISTRY_REPORT.md`; D-013 finalizes on PASS.

### T-006 — First real adapter: GLEIF LEI Index (P2) — COMPLETE 2026-10-13

- Objective: one reliable end-to-end discovery path (terms-verified source), not every category. Selected over OpenCorporates (key gate), Companies House (account + UK-only), directories/social/paid (no permitted programmatic access). See `docs/T006_SOURCE_SELECTION.md`.
- Prerequisites: T-005 ✓ + terms review ✓ (public open-data API, keyless, verified live).
- Files: `lib/discovery/adapters/gleif.ts`, `lib/discovery/http.ts`, `lib/discovery/run.ts`, `lib/discovery/production.ts`, `app/api/discovery/runs*`, `/discovery` workspace, `db/migrations/20261013000006_discovery_runs.sql` + `...0007_source_kinds.sql`, `tests/gleif.test.ts` + `tests/fixtures/gleif/*`.
- Result: bounded synchronous runs (≤25/page, ≤3 pages, 120s) with idempotent per-record create-or-review handoff; conflicts never merged or overwritten.
- Verification: 19 adapter/run tests (recorded fixtures; live smoke opt-in, passed); full 129/129 suite; tsc + build clean; live HTTP round-trip (run ok, found=1 new=1, history recorded).
- Acceptance: FR-006/FR-007 met (provenance per record, typed failures, manual fallback intact).
- Risks: agency yield expected low (LEI skew); rate limits unverified (bounded runs + backoff); no resume after crash (documented).

### T-007 — Evidence ledger, claim assessment & provenance (P2) — COMPLETE 2026-10-13

- Objective: auditable evidence ledger (observations, claims, assessments, provenance). Covers plan T-007 (observation capture: hash, event/capture timestamps, retention flags) + ledger/contradiction core of plan T-008.
- Prerequisites: T-002…T-006 ✓.
- Files: `lib/evidence/*` (hash/assessment/ingest/detail), `app/api/evidence/*`, `app/api/claims/*`, `/evidence/[id]`, agency claims section, `db/migrations/20261013000008_evidence_assessment.sql` + `...0009_assessment_delete_policy.sql` + `...00010_evidence_cascade.sql`, `tests/evidence.test.ts`.
- Result: 8 statuses + disputed/withdrawn/superseded/computed-stale; verified human-only; append-only history; evidence links with polarity; idempotent ingestion; GLEIF runs capture identity observations.
- Verification: 16/16 evidence tests + full 145/145 suite + tsc/build clean + HTTP round-trip (ingest→assess→flag→detail). See `docs/T007_EVIDENCE_LEDGER_REPORT.md`.
- Acceptance: all T-007 gates hold (see report).
- Risks: retention windows (D-008) still open; injection-fixture quarantine for future HTML fetching stays with plan T-008.

### T-008 — Claims ledger + contradictions + injection handling (P2)

- Objective: FR-009…FR-012 — REMAINING: injection-fixture quarantine suite for future HTML/untrusted-web fetching (ledger + contradiction core completed under T-007 above).
- Prerequisites: T-007 ✓.
- Files: `lib/evidence/*`, `tests/evidence*`.
- Result: status/reliability/credibility recorded; contradictions surfaced; injection fixtures quarantined.
- Verification: ledger tests + injection-fixture suite + no-false-negative tests.
- Acceptance: G1 + G7 pass.
- Risks: R-03/R-04.

### T-009 — Company profiles, proposals & commercial evaluation (P1) — COMPLETE 2026-10-13

- Objective: profile assembly from existing records + structured proposals + transparent estimation (this task's scope; absorbs plan T-009/T-010 for this phase).
- Prerequisites: T-002…T-008 ✓.
- Files: `lib/proposal/*`, `app/api/proposals*`, `app/proposals/*`, upgraded `/projects` + agency profile sections, `db/migrations/20261013000014_proposal_lifecycle.sql`, `tests/proposal.test.ts`.
- Result: validated-hypothesis-gated drafting, versioned estimates with assumptions, lifecycle with audit, freshness flags, merge-safe history.
- Verification: 14/14 proposal tests + full suite + tsc/build clean + HTTP round-trip. See `docs/T009_PROJECT_PROPOSAL_REPORT.md`.
- Acceptance: all T-009 gates hold (see report).
- Risks: D-004 catalog content + D-005 pricing still open (placeholders/ranges only).

### T-010 — Opportunity briefs, catalog & sales workflow (P1) — COMPLETE 2026-10-13

- Objective: traceable briefs from accepted proposals + honest draft catalog + human-only pipeline/outcomes/drafts.
- Prerequisites: T-002…T-009 ✓.
- Files: `lib/sales/*`, `app/api/briefs*`, `app/api/drafts*`, `app/api/catalog*`, brief workspace + catalog + pipeline/outreach upgrades, `db/migrations/20261013000015_briefs_pipeline.sql` + `20261013000016_outcome_cascade.sql`, `tests/sales.test.ts`, `docs/T010_OWNER_DECISIONS.md`.
- Result: versioned briefs with frozen inputs, gated lifecycle, stage history + follow-ups, versioned drafts with approval gate, audited catalog states, manual-only outcomes.
- Verification: 12/12 sales tests + full 187/187 suite + tsc/build clean + HTTP round-trip (incl. live 409 approval block). See `docs/T010_SALES_WORKFLOW_REPORT.md`.
- Acceptance: all T-010 gates hold (see report).
- Risks: D-004/D-005 open (placeholders/ranges); no reminder delivery by design.

### T-011 — Deterministic scoring + ranking (P3) — COMPLETE 2026-10-13

- Objective: FR-019/FR-020 — audited, gated, versioned score_v1 engine (weights provisional, D-006 open).
- Prerequisites: T-002…T-010 ✓.
- Files: `lib/scoring/*`, `app/api/scores*`, upgraded `/scores` + hypothesis score hooks, `db/migrations/20261013000018_scoring_runs.sql`, `tests/scoring.test.ts`, `docs/T011_SCORING_AUDIT.md`, `docs/T011_CALIBRATION_PROTOCOL.md`.
- Result: hard gates before ranking (ineligible get no row), dimension rationale + missing flags, versioned history, read-time staleness, deterministic ties.
- Verification: 15/15 scoring tests + full 202/202 suite + tsc/build clean + HTTP round-trip (evaluate 57/B, ranked, page 200). See `docs/T011_SCORING_CALIBRATION_REPORT.md`.
- Acceptance: all T-011 gates hold (see report).
- Risks: weights provisional (no tuning without n≥30 reviewed outcomes); D-004/D-005 cap strategic/commercial depth.

### T-012 - Review queue + briefs + drafts, no send path (P4) - COMPLETE 2026-10-13 (verdict PASS)

- Objective: FR-021.FR-023.
- Prerequisites: T-011 (satisfied).
- Files: `lib/review/queue.ts`, `app/review/page.tsx`, `tests/review.test.ts` (new); `vitest.config.ts` (`fileParallelism: false`, see R-01).
- Result: ordered unified queue over nine implemented workflows (identity, evidence, hypothesis, proposal, brief, draft, catalog, gates, stale) as a read-model projection with **no queue table and no writes**; deterministic five-tier priority that never uses the opportunity score; staleness delegated to the owning domain helpers; bounded substring search + offset pagination (max 200); deep links into existing authorized workflows. Briefs keep their provenance; drafts remain human-send-only and the no-send path is unchanged.
- Verification: 20/20 new tests; 15 files / 222 passed / 1 skipped / 0 failed (run twice); `tsc --noEmit` clean; `npm run build` clean; `db.mjs migrate` `already up to date`; container healthy; HTTP round-trip on the production build. No-send guard is the existing repository-wide scan in `tests/sales.test.ts` plus new static guards on `lib/review/queue.ts`.
- Acceptance: G5 passes (no automated send path); AC-003 passes (one unified review surface over existing state, not a second source of truth).
- Risks: R-05 QA attestation remains outstanding. New: R-01 cross-file test coupling (mitigated by sequential test files and non-colliding fixture namespaces); R-02 pre-existing stale `source`-count assertion in `db/tests/t002_verify.sql` (reported, not modified).
- Report: `docs/T012_REVIEW_QUEUE_REPORT.md`.

### T-013 - Outcomes + rejection/failure logs + learning reports (P4) - COMPLETE 2026-10-13 (verdict PASS, Milestone 2)

- Objective: FR-024/FR-025.
- Prerequisites: T-012 (satisfied).
- Files: `lib/outcomes/reports.ts`, `app/pipeline/page.tsx` (Learning section), `tests/outcomes.test.ts` (new). Pre-existing (T-002/T-010, preserved): `outcome_log` + controlled rejection vocabulary, `failure_log` + cause classes, `pipeline_event`, manual recording routes (`POST /api/briefs/[ref]/outcomes`, `/pipeline`, `/outcomes`), brief-workspace outcome display.
- Result: manual logs + controlled vocabulary (pre-existing) + **basic learning reports (new)**: overview reply/win rates, rates by agency type / channel / hypothesis category / contributing source, top rejection reasons with shares, evidence-ledger health. Every rate carries n/N; denominators <5 report "insufficient data" instead of a percentage. Reports are read-only descriptive aggregates — nothing tunes weights or thresholds.
- Verification: 6/6 new tests; full suite + tsc + build green; pipeline page renders the section (HTTP smoke).
- Acceptance: G6 subset passes (manual logs + controlled vocabulary + basic reports with confidence limits on sparse data).
- Risks: sparse data → all rates correctly show insufficient-data until outcomes accumulate; source attribution is a documented approximation.
- Report: `docs/T013_OUTCOMES_LEARNING_REPORT.md`.

### T-014 — 20-brief validation + MVP sign-off (P5) — NOT STARTED

- Implementation-ready specification: `docs/T014_VALIDATION_PROTOCOL.md`
  (11 elements: cohort rules, inclusion/exclusion, evidence rubric, identity
  requirements, hypothesis rules, G1–G6 brief rubric, frozen-score methodology,
  outcome labels + limitations, reviewer recording, reporting format, data
  protection) + single case-file format `docs/T014_RECORDING_TEMPLATE.md`.
- Start requires all five §12 approvals (sample plan, D-004/D-005 posture, QA
  assignee, provisional-weights acceptance, labor commitment). Missing any
  one: T-014 does not start. Do not begin without owner commitment.
- Pilot executed under user authorization (explicitly non-sign-off):
  `docs/REAL_WORLD_VALIDATION_REPORT.md` (20 real agencies, isolated
  `agency_intel_validation` DB, 7 approved briefs, reproducibility 7/7,
  0 fabrications). T-014 status UNCHANGED by the pilot.

- Precondition note: AUTH-001 is implemented (operator sign-in enforced on all pages and API routes; register D-018). Any future endpoint or page MUST call `requireOperatorApi` / `requireOperatorPage` like the existing ones — the handler/gate parity check in the AUTH-001 report is the pattern to preserve.

- Precondition note: `node scripts/db.mjs seed` is repeatable on a fully migrated database as of
  R-03 (`docs/R03_SEED_COMPATIBILITY_REPORT.md`); the seeded demo record is `needs_review` with
  3 supporting + 1 contradicting claim and a `legacy` score row.

- Precondition note: Discovery discovery/collection plumbing (Prompt 4–5) is implemented and
  executed against a real database — 33 migrations, manual refresh, opportunity collection,
  source-permission gate, crashed-run reaping, identity-conflict capture. See
  `docs/DISCOVERY_READINESS_REPORT_PROMPT5.md`. This does **not** start T-014 and does not
  approve counting/eligibility content (O2/O3/O10 remain OPEN).

### T-014 — original task stub (kept for history; specified above)

- Objective: AC-001…AC-005 on worldwide agency briefs (mixed agency types + countries).
- Prerequisites: T-001…T-013.
- Files: evidence bundle (brief IDs, gate results, outcome starter log).
- Result: 20 briefs reviewed; docs audit re-run; MVP decision recorded.
- Verification: gate matrix + reproducibility + link audit, all with actual outputs.
- Acceptance: all AC items met; any gap reported honestly, not waived.
- Risks: quality shortfall → do not scale; record follow-ups.
