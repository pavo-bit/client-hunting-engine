# T011_CALIBRATION_PROTOCOL — From Provisional Weights to Evidence

> Status: weights are PROVISIONAL (D-006 open). This protocol defines exactly what data and analysis would justify changing them. Nothing here tunes anything today.

## 1. Why calibration is premature

- Reviewed opportunities with recorded outcomes: ~1 (seed brief; synthetic).
- Rule of thumb: no weight changes before **n ≥ 30** reviewed opportunities each with a recorded terminal outcome (won/lost/disqualified) plus operator decisions.
- Tuning on anecdotes guarantees overfitting; the engine stays provisional until then.

## 2. Required evaluation dataset

One row per reviewed opportunity, frozen at review time (no leakage):

| Field | Source |
|---|---|
| hypothesis_id, model_version, evaluated_at | `score_run` row |
| component points + missing[] + gates | `detail` JSON + `gate_notes` |
| total, band, partial | generated columns |
| operator decision + rationale + timestamp | hypothesis/proposal/brief audit |
| terminal outcome + observed_at | `outcome_log` + pipeline events |
| evidence snapshot (claim ids + statuses at scoring time) | `hypothesis_evidence` + `claim` history |

Collection rule: record the score BEFORE the decision; never recompute history with newer models (versions coexist; comparisons are version-pinned).

## 3. Evaluation methodology (when n ≥ 30)

1. **Rank agreement:** operator's investigation order vs model order (rank correlation on the reviewed set).
2. **Gate precision:** share of excluded items operators agree should have been excluded (sampled audit, not all).
3. **Band calibration:** reply/meeting/win rates per band with confidence intervals; bands are ordering hints, never probabilities.
4. **Ablation:** re-score with each dimension zeroed; report rank displacement (justifies or kills weights).
5. **Failure review:** every won-below-C and lost-above-A gets a written post-mortem feeding rule/threshold proposals via `D-*` decisions.

## 4. Success criteria for leaving provisional status

- Rank agreement stable across two consecutive 30-case windows.
- No dimension with zero ablation displacement keeps a non-zero weight.
- All changes recorded as `D-*` decisions with rationale; model version bumped (`score_v2`); `score_v1` rows untouched.

## 5. What stays true regardless

Scores never override gates; missing stays explicit; synthetic fixtures never count as validation; commercial outcomes never tune evidence weights directly (they inform thresholds through decisions, not gradients).
