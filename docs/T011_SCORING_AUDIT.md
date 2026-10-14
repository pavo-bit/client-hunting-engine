# T011_SCORING_AUDIT — Existing Scoring Model Before Changes

> Date: 2026-10-13. This audit precedes any weight or engine change (T-011 §3).

## 1. Every score, formula, threshold, default, gate (inventory)

| Item | Location | Form |
|---|---|---|
| `score_run` components (fit/evidence/opportunity/feasibility/timing/deductions) | `db/migrations/20261012000005` | Plain integer columns, `>= 0` checks only — **no provenance, no input refs** |
| `total` | same migration, `GENERATED ALWAYS AS (fit+evidence+opportunity+feasibility+timing-deductions) STORED` | Deterministic arithmetic, always consistent |
| `band` (A≥75/B≥55/C≥35/D) | same migration, generated | **Provisional thresholds baked into DDL** (D-006 open) |
| `weight_version` | text column, default `v0.1-PROVISIONAL` | Label only — no versioned rule set behind it |
| `gates_passed` + `gate_notes` | boolean + text, with check (fail requires notes) | Advisory only — **nothing enforces gates before ranking** |
| Estimation ranges (effort/cost) | `lib/proposal/estimate.ts` v1 + `project_option` columns | Versioned, assumption-backed; NOT a score input (correct separation) |
| Hypothesis rules | `lib/hypothesis/rules.ts` v1 | Generate-or-silence only; emit no numbers (correct separation) |

## 2. Where scores are calculated, stored, displayed, consumed

- Calculated: **nowhere in code** — the single existing row is hand-inserted seed data. No engine, no API, no UI creates scores.
- Stored: `score_run` (hypothesis link, components, total, band, gates flag).
- Displayed: `/scores` page (components, total, band, gates badge) and brief detail (total/band).
- Consumed: nothing ranks by them; the review queue is status-ordered, not score-ordered.

## 3. Double-counting

Not currently possible (no engine), but the design risk is real: evidence strength, corroboration status, and hypothesis specificity all derive from the same claim set. The new model must count each fact once (finding → dimension budget in §4 of the final model).

## 4. Missing-data handling

Absent: components default to nothing (NULLs rejected by NOT NULL — a score row cannot express "unknown"). Missing data can neither be distinguished from low values nor flagged. **Fix required.**

## 5. Weak-evidence inflation

Possible by construction: any five integers sum to a total with no input requirements. A hypothesis with one assumed claim can score 95. No eligibility gate is enforced at write time. **Fix required (hard gates).**

## 6. Ineligible records ranking

`scores` page lists every `score_run` row regardless of hypothesis status (rejected/validated/superseded all rankable), and `gates_passed=false` rows still display with totals. **Fix required.**

## 7. Separation of concerns (to preserve)

Hypothesis generation (possibility), estimation (ranges), commercial evaluation (operator ranges), and prioritization (this task) are already separate code paths. The new engine must not merge them: it reads their outputs, never recomputes them.

## 8. Provisional vs grounded parameters

- Provisional: all five weights, all four band edges, deductions schedule, sufficiency counts.
- Grounded: append-only audit, deterministic arithmetic, human-only validation, locked scope/segment rules.
- Blocked by owner: D-004 (approved capabilities → strategic-fit ceiling), D-005 (pricing policy → commercial dimension limits), D-006 (weights/thresholds).

## 9. Decision for implementation

Replace hand-written score rows with a versioned engine (`score_v1`) that: derives dimensions from stored evidence/hypothesis/proposal rows, enforces hard gates before ranking, marks missing/provisional dimensions explicitly, versions every evaluation, preserves history, and never overrides gates with totals. Detailed design in `docs/SCORING_AND_OPPORTUNITY_MODEL.md` §8+.
