# T008_HYPOTHESIS_ENGINE_REPORT — Business-Problem Hypothesis Engine

> Date: 2026-10-13. No ML, no LLM, no probabilities, no web browsing, no outreach changes. Hypotheses are reasoned possibilities, never facts.

## Verdict: PASS

## 1. Taxonomy and deterministic rules implemented

- `lib/hypothesis/taxonomy.ts` (v1): 5 categories with problem, legitimate support, insufficient-alone lists, alternatives, validation questions, interventions, must-not-generate conditions; 3 ruleless categories (ecommerce/mobile/other) that stay silent by design.
- `lib/hypothesis/rules.ts` (rules v1): `R-PORTAL-01`, `R-HIRING-01`, `R-INTEGRATION-01`, `R-REPORTING-01`, `R-TESTING-01` — each declares predicates, usable statuses, keywords, and version. Pure `evaluateRules` core (deterministic, unit-tested); persistence layer handles idempotency (open-row unique index + race fallback), evidence top-up, and material-change supersession with audit.
- Safeguards enforced in code: GLEIF/identity-only evidence fires nothing; service advertising alone fires nothing; stale/terminal/disputed evidence excluded from support; assumed claims surface as assumptions; contradictions force `needs_review` and persist; empty result is explicit `noSupportedHypothesis`.

## 2. Schema and migration changes

- `20261013000011_hypothesis_lifecycle.sql`: lifecycle → generated/needs_review/deferred/rejected/validated/superseded (legacy rows remapped, documented), rule traceability + rationale/assumptions/alternatives/missing/questions/intervention/decision columns, open-per-(company,rule) unique index.
- `20261013000012_evidence_polarity_key.sql`: evidence-link key becomes (hypothesis, claim, polarity) — one observation can both trigger and contradict (found by audit-grade testing: the old key silently collapsed the second polarity).
- `20261013000013_hypothesis_default.sql`: default `generated` (the vocabulary change had orphaned `proposed`, breaking T-004 inserts — caught by regression suite).

## 3. Evidence eligibility and contradiction handling

Eligible: observed/corroborated/inferred + fresh. Excluded from support: assumed (→assumptions), disputed/withdrawn/superseded/stale. Snapshot-level contradictions stay on claims; claim-level contradictions link to hypotheses under both polarities where applicable. Merged records are skipped (hypotheses belong to canonical).

## 4. Hypothesis lifecycle and review workflow

Generate → (generated | needs_review) → validate/defer/reject/request_evidence/supersede, all rationale-required and audit-stamped; superseded terminal; re-evaluation tops up open rows, supersedes-on-material-change, no-ops otherwise. Validation records reviewer judgment — UI and docs state it never proves internal problems.

## 5. Injection-resistance tests

Adversarial fixture file (ignore-rules, secret-reveal, score-tampering, fake approval, tool-trigger): engine emits no validated rows, creates no scores, leaks no env values; hostile excerpts stored verbatim and rendered as quoted text (React-escaped). Fake approval changes nothing without human decision; no send paths exist to trigger.

## 6. API and UI additions

`POST /api/hypotheses/generate`, `GET /api/hypotheses`, `GET /api/hypotheses/[id]`, `POST /api/hypotheses/[id]/decision` (all gated per convention); hypotheses list (status filters, rule versions, links), detail page (rationale, both evidence sides, assumptions/alternatives/questions/proposal, decision history), decision dialog, per-company generate button + hypotheses section. Every surface labels hypotheses as unproven.

## 7. Exact test, type-check, build, and regression results

- `tests/hypothesis.test.ts`: **16/16** (taxonomy/rules matrix, silence cases, stale/ineligible, contradictions, idempotency, supersession, merged-skip, 404, all five decisions + guards + audit, concurrency single-row, RLS denial, adversarial battery, verbatim rendering).
- Full `npx vitest run`: **11 files, 161/161** (T-002 SQL + T-003 18 + T-004 30 + T-005 19 + dashboard 7 + auth + gleif 19 + evidence 16, incl. 5000/5001). `tsc` clean. `npm run build` clean.
- HTTP round-trip on production build: generate (R-PORTAL-01) → defer → detail 200; smoke rows removed (seed count 3).
- Defects fixed with evidence: legacy default orphaning T-004 inserts, legacy rejection-reason constraint vs new lifecycle, polarity-key collapse, test-ordering/secret-literal slips.

## 8. Known limitations and unresolved risks

- Keyword matching is deliberately shallow (inspectable over clever); rule coverage is 5 categories, rest silent.
- No full-text hypothesis search; no cross-company pattern mining.
- Domain ownership unverified (prior limitation, unchanged).
- Operator login still open (local-only posture unchanged).

## 9. Recommended next task

**T-009** — business profiles + project proposal generation (consumes validated hypotheses).
