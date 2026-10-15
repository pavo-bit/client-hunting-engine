# EVALUATION BASELINE REPORT (GENERATED — do not hand-edit)

> Generated 2026-10-15T13:32:22.737Z by an explicit operator run of `scripts/evaluate.mjs`.
> Reproduce: `node scripts/evaluate.mjs --target test --actor <label> --fixture [--split dev|heldout|both]`.
> The gold set is SYNTHETIC fixture data measuring engine behavior — never commercial outcomes.
> Thresholds were declared before the first run (lib/eval/harness.ts) and are not tuned on results.

Gold set v1: dev=4 items, heldout=8 items.
Versions: policy p2t-pol-evalrun-1792071136668 / catalog p2t-cat-evalrun-1792071136668 / rubric p2t-rub-evalrun-1792071136668 / capacity p2t-cap-evalrun-1792071136668 / as_of 2026-10-15T00:00:00.000Z.

## Split: dev (4 items)

| Metric | Value | Threshold | Pass | Denominator / notes |
|---|---|---|---|---|
| precision_at_10 | 0.667 | 0.5 | PASS | n=3 — eligible labels in top 10 of multidim order; pool ranked=3 (small-n: wide uncertainty) |
| precision_at_20 | 0.667 | 0.4 | PASS | n=3 — eligible labels in top 20; pool ranked=3 |
| suppression_leakage | 0.000 | 0 | PASS | n=3 — suppressed items appearing in any ranked order; must be zero |
| reviewer_agreement | 0.500 | 0.5 | PASS | n=2 — fraction of dual-reviewed items where reviewers agreed pre-adjudication |
| ranking_stability | 1.000 | 0.8 | PASS | n=3 — worst top-3 overlap across all single-weight ±10% perturbations (max rank displacement 0); small-n caveat applies |

### Baselines (identical eligible pool, identical labels)

| Baseline | P@10 | P@20 |
|---|---|---|
| fit_only | 0.667 | 0.667 |
| recency_only | 0.667 | 0.667 |
| rules_based | 0.667 | 0.667 |
| multidim | 0.667 | 0.667 |

### Unmeasured (capture mechanisms defined, no data yet)

- **operator_review_time**: instrument the review UI with decision dwell time (not built — no fabricated timings)
- **research_task_yield**: link completed tasks to outcome-changing assessments once operators work them
- **decision_change_rate**: count reconsiderations per 100 decisions from case_decision history
- **pursuit_to_conversation_rate**: record outreach outcomes against case_id (outcome_log has no case link yet — schema decision required)
- **qualified_opportunity_rate**: same as above, once commercial outcomes exist

## Split: heldout (8 items)

| Metric | Value | Threshold | Pass | Denominator / notes |
|---|---|---|---|---|
| precision_at_10 | 1.000 | 0.5 | PASS | n=3 — eligible labels in top 10 of multidim order; pool ranked=3 (small-n: wide uncertainty) |
| precision_at_20 | 1.000 | 0.4 | PASS | n=3 — eligible labels in top 20; pool ranked=3 |
| suppression_leakage | 0.000 | 0 | PASS | n=3 — suppressed items appearing in any ranked order; must be zero |
| reviewer_agreement | 0.000 | 0.5 | MISS | n=1 — fraction of dual-reviewed items where reviewers agreed pre-adjudication |
| ranking_stability | 1.000 | 0.8 | PASS | n=3 — worst top-3 overlap across all single-weight ±10% perturbations (max rank displacement 0); small-n caveat applies |

### Baselines (identical eligible pool, identical labels)

| Baseline | P@10 | P@20 |
|---|---|---|
| fit_only | 1.000 | 1.000 |
| recency_only | 1.000 | 1.000 |
| rules_based | 1.000 | 1.000 |
| multidim | 1.000 | 1.000 |

### Unmeasured (capture mechanisms defined, no data yet)

- **operator_review_time**: instrument the review UI with decision dwell time (not built — no fabricated timings)
- **research_task_yield**: link completed tasks to outcome-changing assessments once operators work them
- **decision_change_rate**: count reconsiderations per 100 decisions from case_decision history
- **pursuit_to_conversation_rate**: record outreach outcomes against case_id (outcome_log has no case link yet — schema decision required)
- **qualified_opportunity_rate**: same as above, once commercial outcomes exist
