# T011_SCORING_CALIBRATION_REPORT — Opportunity Scoring Audit, Calibration Framework & Ranking

> Date: 2026-10-13. No ML, no probabilities, no revenue predictions, no weight tuning. Scores summarize inspectable criteria; weak evidence can never look objective.

## Verdict: PASS

## 1. Audit findings (full: `docs/T011_SCORING_AUDIT.md`)

Prior state: no engine — one hand-written seed row; components without provenance; bands baked in DDL; gates advisory-only; missing data inexpressible; weak evidence could total 95; ineligible rows rankable. All confirmed by inspection (no code to misread — there was none).

## 2. Final scoring dimensions and formula

score_v1, weights 30/25/20/15/10 (PROVISIONAL, D-006): Fit (identity completeness 8/10/7/5 — explicitly not ICP match), Evidence (corroborated 10, ≥2 independent origins 8, fresh support 7), Opportunity (rule 8, questions 6, rationale 6 — structure only), Feasibility (proposal 8, high/medium 4/2, approved capability 3; unapproved disclosed at +0), Timing (recency 10/6/2). Deductions live only here (contradictions −5, stale support −5). Missing inputs score 0 AND are listed (`missing[]`, `partial`). Bands A≥75/B≥55/C≥35/D (continuity). Each fact feeds exactly one dimension.

## 3. Hard gates and missing-data behavior

Five gates (active hypothesis, human-reviewed, canonical company, ≥1 support link, identity-clear) — any failure yields NO score row (409 with reasons). Missing dimensions are named, never zero-hidden. Ineligible-vs-uncertain is explicit: gates view vs partial flag. Unreviewed (`generated`) output is an insufficient-evidence state, not a low score.

## 4. Model versioning and history

`score_v1` on every row + legacy marking for pre-engine rows; dimension rationale + weights + missing lists in `detail` JSON; audit event per evaluation; recalculation appends (history endpoint shows all versions); staleness computed at read time against later evidence/audit activity; deterministic ties (total desc, evaluated asc, id asc).

## 5. Sensitivity-analysis results

Deterministic ±20% weight sweeps reproduce exactly; a wide-margin synthetic leader (margin >20 at every sweep point) never reverses. Synthetic only — presented as robustness evidence, never validation.

## 6. Real data available for empirical calibration

~1 reviewed opportunity (seed). Protocol (`docs/T011_CALIBRATION_PROTOCOL.md`) requires n≥30 reviewed + terminal outcomes with pre-decision frozen scores before any tuning. Current state: insufficient — weights stay provisional by rule, not by caution alone.

## 7. Outstanding owner decisions

D-004 (approved capabilities cap strategic fit), D-005 (pricing policy caps commercial depth), D-006 (weights/thresholds — open, with protocol). Nothing invented or silently resolved.

## 8. Exact test, regression, type-check, and build results

- `tests/scoring.test.ts`: **15/15** — boundaries (100/A, 0/D), determinism incl. weight overrides, band edges, risk-only deductions, all five gates + unknown-id, insufficient-evidence states, versioned history + audit, missing/stale dimensions, deterministic ranking + exclusion re-verification, stale detection, unprivileged denial, sensitivity determinism + margin stability.
- Full `npx vitest run`: **14 files, 202/202** (T-002 SQL + T-003 18 + T-004 30 + T-005 19 + dashboard 7 + auth + gleif 19 + evidence 16 + hypothesis 16 + proposal 14 + sales 12, incl. 5000/5001). `tsc` clean. `npm run build` clean.
- HTTP round-trip on production build: evaluate → 57/B partial (matches engine exactly) → ranked (1 row, score_v1) → scores page 200; smoke rows removed (seed count 3).
- Defects fixed with evidence: nested error-shape vs API convention (would have 500'd gate failures), stale-test design vs supersession semantics, history expectations vs honest missing lists, rejection-reason legacy constraint (T-008, found via this suite).

## 9. Known limitations and recommended next task

- Provisional weights; no full-text score search; legacy seed row permanently marked (never recomputed).
- Docker Desktop degraded once mid-task (environmental; recovered).
- Operator login still open (local-only posture unchanged).
- Next: **T-012** (review queue consolidation over validated, gated, ranked opportunities).
