# T009_PROJECT_PROPOSAL_REPORT — Company Profiles, Proposals & Commercial Evaluation

> Date: 2026-10-13. No client budgets/revenue/ROI invented; no quotes issued; no outreach touched. Proposals are structured hypotheses, never commitments.

## Verdict: PASS

## 1. Company profile implementation

No new profile table (reuse, documented): `getCompanyDetail` now aggregates identity + aliases + discovery + candidates + absorbed + audit + **claims** (status/freshness) + **hypotheses** (status/rule) + **proposals** (title/status/version). Agency page renders each in its own card with review states; facts (identity), assessed claims, and review artifacts stay visually and semantically separate; synthetic fixtures remain labeled.

## 2. Proposal schema and lifecycle

- Migration `20261013000014`: status (draft/in_review/needs_info/accepted/rejected/superseded/archived), version chain (+ per-(hypothesis,version) and single-draft uniques), decision provenance, pricing/tax/confidence/timeline fields, estimate inputs + model version, author.
- Eligibility: **validated hypotheses only** (generated/deferred/rejected/superseded → 409 with guidance); creation is explicit (generation creates zero proposals — tested).
- Transitions gated with rationale; terminal states stay decided; "accepted" means internal pursuit only.

## 3. Estimation model and assumptions

`lib/proposal/estimate.ts` v1 (pure): documented person-day baselines (S 2–4 / M 5–10 / L 12–20 / XL 25–40), kind multipliers (integration ×1.5, data ×1.3), security flat +3–5, testing +20%, handover +2–3, contingency ×(1+pct); confidence low on unknowns/XL else medium. Empty/invalid inputs → `insufficient_information` (stored as NULLs, never numbers). Price/timeline are operator inputs (both-or-neither, ranges ordered, 3-letter currency) or absent — never converted, never derived. Assumptions mandatory.

## 4. Versioning and traceability guarantees

Versions supersede (never rewrite); prior statuses/audits intact; capabilities carried forward unless replaced; concurrent versioning serializes to one v2 (unique index → 409); freshness flags fire on post-version evidence/assessment activity AND on hypothesis rejection/supersession; merge history preserved via hypothesis repointing (tested); decided-history immutability enforced through the decision path.

## 5. API and dashboard additions

`POST /api/proposals`, `GET /api/proposals`, `GET /api/proposals/[id]`, `POST /api/proposals/[id]/version`, `POST /api/proposals/[id]/decision` (all token-gated; validated inputs; transactional). UI: proposal form (RHF/Zod, indicative-only copy), detail (scope/commercial/validation/versions/freshness), decision dialog, upgraded projects table, hypothesis-detail draft entry (validated only), agency proposals section.

## 6. Security and audit controls

RLS baseline covers `project_option` (unprivileged denial tested); every create/version/decision writes audit rows; secrets never in scope; untrusted text stored verbatim and React-escaped; no send/submit-externally paths (static scan green).

## 7. Exact tests, regression, type-check, build

- `tests/proposal.test.ts`: **14/14** — model math/boundaries/insufficiency, profile assembly, eligibility (incl. no-auto-creation), strict validation matrix, currency preservation, draft-uniqueness, version/supersede/decision gating, freshness (both triggers), concurrency single-v2, RLS, verbatim rendering, merge preservation, rollback.
- Full `npx vitest run`: **12 files, 175/175** (T-002 SQL + T-003 18 + T-004 30 + T-005 19 + dashboard 7 + auth + gleif 19 + evidence 16 + hypothesis 16, incl. 5000/5001). `tsc` clean. `npm run build` clean.
- HTTP round-trip on production build: company → evidence → hypothesis → validate → proposal v1 → detail 200 + projects 200; smoke rows removed in dependency order (seed count 3).
- Defects fixed with evidence: uuid=text join in freshness query, draft-unique vs versioning order (supersede-first), audit from-status fidelity, orphan-route allowlist for the deliberate proposal funnel, prose tripping the send-pattern scan (reworded, twice).

## 8. Known limitations and unresolved risks

- D-004 catalog content + D-005 pricing open (placeholders/ranges only; capabilities validated by key, never invented).
- Estimation baselines are provisional owner-input-pending; confidence never auto-high.
- No full-text proposal search; no cross-proposal analytics.
- Docker Desktop degraded once mid-task (environmental; recovered, volumes intact).
- Operator login still open (local-only posture unchanged).

## 9. Recommended next task

**T-010** — capability catalog content (D-004, needs owner input) followed by deterministic scoring calibration (T-011, D-006).
