# SCORING_AND_OPPORTUNITY_MODEL — Deterministic and Explainable

> LOCKED: deterministic rules only in MVP; no ML. Weights below are PROVISIONAL. Scores never override gates. Related: `DATA_MODEL_AND_EVIDENCE.md`, `LOW_LEVEL_PLANNING.md` T-011.

## 1. Pipeline

Eligibility → Evidence-sufficiency → Hypothesis validation → Feasibility → Commercial case → Ranking. Failure at any gate stops promotion regardless of points.

## 2. Gates (must all pass before ranking counts)

- G-ELIG: in worldwide agency segment (per D-001/D-002); not rejected/archived; identity resolved.
- G-EVID: ≥ TBD supporting claims (D-006), ≥1 corroborated (or 2 independent observed), linked contradictory evidence where available, no unacknowledged contradiction, freshness within horizon.
- G-FEAS: mapped to ≥1 catalog entry; technical feasibility assessed (not `unknown`); capability fit, commercial assumptions, and validation questions recorded.
- Safety: injection-tainted items excluded; PII/retention holds.

## 3. Provisional scorecard (PROPOSAL — TBD D-006)

Total 100 = Fit 30 + Evidence 25 + Opportunity 20 + Feasibility 15 + Timing 10.

| Factor | Max | Provisional signals |
|---|---|---|
| Segment fit | 30 | Agency-type match (per §2 vocabulary), service-line relevance, opportunity-category fit. No country bonus/penalty by default; country/region act only as operator-configured filters, not score factors (PROPOSAL, TBD D-006) |
| Evidence strength | 25 | Corroborated count, source-reliability mix, freshness |
| Opportunity clarity | 20 | Hypothesis specificity + supporting/contradicting balance |
| Feasibility | 15 | Catalog match strength, integration surface observed, risk deductions |
| Timing | 10 | Recency of hiring/launch/announcement signals |

Deductions: stale evidence −5..−15; open contradiction −10 pending ack; single-source-only −5. Exact numbers TBD; record version (`score v0.1-PROVISIONAL`).

## 4. Worked example (illustrative, not normative)

`Fit 24 + Evid 15 + Opp 14 + Feas 10 + Timing 6 − stale 5 = 64/100`, band B. Explanation lists each addend + evidence IDs + weight version. Same inputs → same output (reproducibility test).

## 5. Bands and queue use

PROPOSAL: A ≥75, B 55–74, C 35–54, D <35 (TBD). Bands order review, never auto-reject; D-band items remain inspectable.

## 6. Confidence and limitations

Scores reflect observable evidence completeness, not ground truth about agency internals. Public research cannot establish most internal operational problems as facts; briefs must label them hypotheses with validation questions for the human-led conversation. Single-source, aged, or assumption-heavy items carry explicit limits in briefs. Commercial attractiveness uses ranges + assumptions (see project-architect role); scoring consumes the range midpoint only as ordering hint, flagged as such.

## 7. Calibration

Outcome logs (reply/meeting/win, rejection codes) feed periodic reports (reply/win by band, source, hypothesis type). Threshold/weight changes only via recorded `D-*` decisions — no automatic tuning in MVP.

## 8. Boundary with hypothesis generation (T-008)

Deterministic hypothesis rules (`R-*-01` v1, taxonomy v1) decide *whether* a possibility is worth investigating from eligible evidence; this scoring model later orders *validated* opportunities commercially. The two never mix: rule evaluation emits no scores, bands, or rankings, and scoring never generates hypotheses. A hypothesis's `needs_review`/`generated` state is not a score input until human validation plus evidence gates pass (see §2).

## 9. score_v1 engine (IMPLEMENTED T-011, weights provisional D-006)

Unit: one hypothesis. Dimensions (no fact counted twice): Fit 30
(identity completeness: domain 8, registry 10, country 7, type 5 — NOT an
ICP match, no ICP is defined); Evidence 25 (corroborated 10, ≥2 independent
origins 8, fresh support 7); Opportunity 20 (rule 8, questions 6, rationale
6 — structure only); Feasibility 15 (proposal 8, high/medium 4/2, approved
capability 3; unapproved links disclosed at +0); Timing 10 (recency
10/6/2). Deductions live only here: contradictions −5, stale support −5.
Missing inputs contribute 0 AND are listed (`missing[]`, `partial` flag).
Bands A≥75/B≥55/C≥35/D (continuity with the legacy generated column).

Hard gates (all must pass; failures produce NO score row): hypothesis
active (not rejected/superseded), human-reviewed (not `generated`),
canonical company, ≥1 supporting evidence link, no pending identity
conflicts. Ties: total desc, evaluated asc, id asc. Every run is versioned
(`score_v1`), rationale-bearing, audited, and preserved; staleness is
computed at read time against later evidence/audit activity. Scores are
ordering hints, never probabilities or revenue predictions. Full audit:
`docs/T011_SCORING_AUDIT.md`. Calibration protocol:
`docs/T011_CALIBRATION_PROTOCOL.md`.
