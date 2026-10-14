# T013_OUTCOMES_LEARNING_REPORT — Outcomes, Rejection Logs & Learning Reports

> Date: 2026-10-13. T-013 objective FR-024/FR-025, prerequisite T-012 satisfied.
> Expected result per register: "manual logs; controlled rejection vocabulary;
> basic reports." All three now hold.

## Verdict: PASS

## 1. What T-013 required and where it stands

| Requirement | Status | Evidence |
|---|---|---|
| FR-024 manual outcome recording (sent date/channel, reply, meeting, win/loss, deal range, rejection reason + free text, failure class) | IMPLEMENTED (T-010), preserved | `recordOutcome` (lib/sales/briefs.ts:383): controlled outcome/channel/rejection vocabularies, free-text note (≤4000), manual sent date, operator attribution; routes `POST /api/briefs/[ref]/outcomes` (auth + CSRF); 422 on bad values, 404 on unknown brief |
| Controlled rejection vocabulary | IMPLEMENTED (T-010), preserved | `no_fit/no_budget/no_response/bad_timing/competitor/chose_other/other`, ranked by `topRejections` |
| FR-025 rejection/failure log | IMPLEMENTED (T-002/T-010), preserved | `failure_log` (cause classes incl. `injection_suspect`) + `outcome_log`; /audit page; failure cause index |
| FR-025 basic learning reports | **IMPLEMENTED this milestone (was missing)** | `lib/outcomes/reports.ts` + pipeline-page section (see §2) |
| Reports inform tuning via recorded decisions; no automatic weight changes | HOLDS | Reports compute descriptive rates only; no writer touches weights/thresholds (static assertion: no import of scoring writers in `lib/outcomes/`) |

"Failure class" (FR-024) is covered two ways: system failures carry
`failure_log.cause_class`; sales outcomes carry outcome + rejection code, from
which the reports derive reply/win classes. No schema change was needed.

## 2. Learning reports (new in Milestone 2)

`lib/outcomes/reports.ts` — read-only, parameterized, bounded; performs zero
writes (audit invariance tested):

- `outcomeOverview`: totals + reply rate (replied/positive/meeting/discovery/proposal/won) + win rate, each as `{n, denom, rate, lowData}`.
- `ratesBySegment` (agency_type), `ratesByChannel`, `ratesByHypothesisCategory`,
  `ratesBySource` (brief counts once per contributing source — documented
  approximation, not per-source outcome attribution).
- `topRejections`: rejection codes ranked among lost outcomes with shares.
- `evidenceHealth`: claim counts by terminal/expired state + approved-brief count.
- Sparse data is a first-class result: denominators below `MIN_DENOM = 5`
  yield `rate: null, lowData: true` ("insufficient data"), never a percentage.

Surfaced on `/pipeline` as "Learning reports (FR-025)" with an explicit
no-auto-tuning notice. Empty states render honest zeros, never errors.

## 3. Verification

- `tests/outcomes.test.ts`: **6/6** — overview math, all four groupings,
  low-data honesty, rejection ranking, evidence health, empty-slice zeros,
  determinism, audit invariance.
- Regression: full suite green (see Milestone 2 report §8); `tsc` clean;
  `npm run build` clean; pipeline page renders the section on seed data
  (verified in HTTP smoke, Milestone 2 report §8).
- No-send boundary intact (repository scan still passes); AUTH-001 guards on
  all touched routes (no new unguarded endpoint: reports ship through the
  existing guarded page, no new API route was needed).

## 4. Known limits

- With ~1 seeded outcome, every rate shows "insufficient data" — correct, by design.
- Source attribution is approximate (documented in code + UI caption).
- No trend-over-time views (would need denser outcome history; a future task).
- D-006 calibration still needs n≥30 reviewed outcomes; these reports are the collection instrument, not the calibration.

## 5. Next

T-014 (20-brief validation + MVP sign-off) per `docs/T014_VALIDATION_PROTOCOL_PROPOSAL.md`
(proposed spec, not started).
