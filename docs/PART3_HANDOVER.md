# PART 3 HANDOVER — Lifecycle, Review, Research, UI, Evaluation → Pilot decision

> **Date:** 2026-10-15. Part 3 is implemented, tested and verified below.
> The pilot is NOT activated (verdict: PILOT BLOCKED — see
> [PILOT_READINESS_REPORT.md](PILOT_READINESS_REPORT.md)). No owner reply
> arrived during Part 3; every O/D item in
> [the decision packet](PART1_OWNER_DECISION_PACKET.md) is still OPEN.

## 1. Exit-gate status (Part 3 definition of done)

| Required operator capability | Status | Evidence |
|---|---|---|
| Move from a Discovery opportunity to an evidence-supported qualification | PASS | assess console + `runAssessment` pipeline |
| Inspect rationale (dimensions, gates, evidence for/against) | PASS | case detail page, all §4 sections |
| Research missing information (manual, decision-valued) | PASS | research workspace + task workflow + due flags |
| Make a controlled human decision | PASS | decisions API + form; immutable cited records; conflict/stale/suppression rules |
| Review the audit history | PASS | lifecycle + audit section on case detail; decisions/metrics page |
| Ranking reproducible and explainable | PASS | lexicographic engine + explainer + persisted snapshots; eval stability 1.0 |
| Evaluation compares against baselines | PASS | harness + gold v1 + 4 baselines + generated report |
| Remaining blockers visible | PASS | decision packet (unchanged, confirmed), pilot report, this handover |
| Local and manual throughout | PASS | no scheduler/worker/outreach/ML anywhere (static scans + architecture) |

## 2. Exact files (Part 3 additions)

| Area | Files |
|---|---|
| Migration | `db/migrations/20261015120001_case_decisions.sql` (M18: `p2.case_decision` + unique conflict rule + deferral-resume CHECK + `research_task.due_at` + RLS/grants/policies) |
| Lifecycle | `lib/qualification/decisions.ts` (`decide()`, display-state derivation, history); `deferral` added to policy type+lint (optional, enforced only when present) |
| Race guards | `assertAssessmentCurrent` in `assessments.ts` (wired pre-record); real `business_relationship` rows into scoring (handover limitation #3 closed) |
| Research ops | `createResearchTask`, `setResearchTaskDue`, `getResearchTask` in `research.ts` |
| Routes | `decisions/route.ts`, `reconcile/route.ts` (POST run + GET pure preview), `research/route.ts` (manual create), `research/[id]/route.ts` (status + due), `policy/route.ts` (lint/draft/publish/retire); case detail extended with decisions |
| UI pages | `/today`, `/qualification` (+report, suppressed toggle), `/qualification/cases/[id]`, `/qualification/assess`, `/qualification/research`, `/qualification/policy` (+capacity), `/qualification/audit`, `/admin` + nav entries (no orphans — enforced by test) |
| UI components | `decision-form`, `assess-form`, `task-controls`, `policy-forms`, `reconcile-panel` (+ shared `dashboard.ts` reads) |
| Evaluation | `eval/goldset.v1.json` (12 items, 9 kinds, dev/heldout split), `lib/eval/baselines.ts`, `lib/eval/harness.ts`, `scripts/evaluate.mjs` (+ `scripts/ts-resolve.mjs`/`ts-register.mjs` loader hook), `docs/EVALUATION_BASELINE_REPORT.md` (generated) |
| Tests | `qualification_decisions` (10), `qualification_lifecycle_routes` (6), `evaluation` (9) — 25 new; Part 3 total surface also covers policy/evidence/gates/scoring/ranking/assessments/routes suites |
| Docs | `PILOT_READINESS_REPORT.md` (BLOCKED), `QUALIFICATION_GATE_REGISTRY.md`, `QUALIFICATION_API_CONTRACTS.md`, `PHASE2_DATA_DICTIONARY.md`, this handover; updated traceability, findings, RUNBOOK, contracts |

## 3. Test commands and results (executed)

```
npx vitest run                                    → 53 files, 541 passed, 1 skipped (543), 1 failed
                                                    (docs_consistency on grant-language in the new pilot
                                                    report → rephrased, re-verified green targeted)
npx tsc --noEmit                                  → clean (repeated, incl. after last edit)
npm run build                                     → compiled successfully (all pages + routes)
node scripts/db.mjs verify                       → verify ok (dev, live data)
node scripts/db.mjs verify (scratch)              → verify ok (migrated forward, seed intact)
node scripts/backup.mjs backup|verify|restore     → ok (44 migrations, 8 companies, 12 categories, 0 orphans;
                                                    retention: 4 dev dumps + protected legacy)
node scripts/evaluate.mjs --target test --actor p2t --fixture --split both
                                                  → exit 0, report generated (heldout: P@10/20 1.0, leakage 0,
                                                    stability 1.0, agreement 0/1 MISS by design n=1)
node scripts/qualify.mjs assess …                 → 409 no active policy (fail-closed, still correct)
```

The single full-suite failure was documentation wording, fixed and re-verified;
nothing else failed. The skip throughout is the opt-in live-GLEIF smoke.

## 4. Known limitations (do not relitigate — decide)

1. **No active production policy/catalog/rubric/capacity** (O10, D-004, D-006,
   O7 OPEN). First step after O10: publish real versions, re-run evaluation
   with re-declared thresholds.
2. **Signal families come from an explicit predicate map.** Unmapped
   predicates are unusable, not defaulted; curate as new sources land (O9).
3. **Research effort table is heuristic** (ordering only) — never cost/value.
4. **Outcome capture for commercial metrics is undefined** (`outcome_log` has
   no case link — schema decision required, owner-gated by O11 scope).
5. **Review time is uninstrumented** (no fabricated timings).
6. **Gold set is synthetic** (n=12): engine-behavior evidence only; agreement
   metric needs a larger dual-reviewed set in gold v2.
7. Thresholds are version-bound: a new policy or gold version re-declares
   them; carrying them over silently invalidates the evaluation.

## 5. Unresolved decisions (confirmed unchanged 2026-10-15)

O1, O2, O3, O4, O7, O10, O11, T-014 §12(a)–(e), R-05, D-004, D-005, D-006,
D-008, B-D1, B-D13, F18 — all still OPEN, all in
[PART1_OWNER_DECISION_PACKET.md](PART1_OWNER_DECISION_PACKET.md). Nothing in
Part 3 invented any of them: production has no active versions, the UI states
that openly, and the pilot stays blocked.

## 6. What Part 4 (or the owner) does next, in order

O10 → publish policy/catalog/rubric (P2-01) → assess the accumulated
`observed` population → work the queue and research → blind independent review
of ≥30 cases → re-run evaluation → O1/O2/O3/O7 as they land → pilot only after
O11/T-014/R-05/B-D1/B-D13 close. Backlog P2-01…P2-12 in
[PART2_BACKLOG.md](PART2_BACKLOG.md) still applies, minus P2-11 (case UI —
now built).
