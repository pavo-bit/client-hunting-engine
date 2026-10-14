# T010_SALES_WORKFLOW_REPORT — Briefs, Catalog & Human-Controlled Sales

> Date: 2026-10-13. Internal tool only: drafts are copy-only, outcomes are human-observed, nothing sends or syncs. Catalog content awaits the owner (D-004).

## Verdict: PASS

## 1. Opportunity brief model and lifecycle

- `brief` extended: `proposal_id` link, `version`, decision provenance, pipeline fields (`pipeline_stage`, `next_action`, `follow_up_date`), statuses draft/in_review/approved/needs_info/rejected/superseded/archived (legacy `needs_work` remapped). One active brief per proposal (partial unique — duplicate actives rejected 409).
- Creation is explicit from **accepted** proposals only; inputs frozen by SHA-256; markdown sections cover company context, rationale (facts vs assumptions), project (ranges labeled), and action plan. Unapproved capabilities trigger explicit warnings, never approval.
- Decisions gated with rationale; terminal states stay decided; hypothesis rejection/supersession and post-version evidence flag staleness without rewriting history.

## 2. Pipeline stages and event history

- 11 stages (research → won/lost/disqualified/on_hold); notes required on every change; follow-ups validated (YYYY-MM-DD, real, bounded); `pipeline_event` history + brief current-state update in one transaction; stage board + 7-day follow-up list; no auto-advance, no reminders sent.

## 3. Outreach draft controls and no-delivery confirmation

- Drafts versioned (history immutable; ready rows locked), revise creates versions, approve requires rationale AND zero unverified points (409 otherwise). Copy-to-clipboard retained.
- No-delivery proof: schema has no send/status-delivery columns, no queues/workers/routes; repository scan (libraries, protocols, automation verbs, browser frameworks) over app/lib/components passes; approval gate live-verified (409 on unverified draft over HTTP).

## 4. Service-catalog owner decisions

- `capability.status` (draft/needs_owner_review/approved) + audited transitions; seed placeholders stay unapproved; briefs label non-approved capabilities; `/catalog` UI with approval warnings; `docs/T010_OWNER_DECISIONS.md` lists 8 open items with why/provisional guidance. Nothing invented on the owner's behalf.

## 5. Schema, API, and UI changes

- Migrations: `...15_briefs_pipeline` (brief link/lifecycle/pipeline fields, pipeline_event, outcome vocabulary, draft status/version/unverified gate), `...16/17_outcome_cascade` (duplicate file number removed, history reconciled — cascade coherence with 8g/8k).
- APIs (all token-gated): briefs create/decision, pipeline, outcomes; drafts create/revise/decision; catalog status.
- UI: brief workspace (package, pipeline, outcomes, drafts, decisions), catalog page + nav, pipeline board + follow-ups, outreach index with status/unverified badges, proposal links throughout.

## 6. Authorization and audit controls

RLS + PUBLIC revokes on `pipeline_event` (denial tested); every mutation audited with actor + rationale; local-only posture unchanged; secrets never in scope.

## 7. Exact test, regression, type-check, and build results

- `tests/sales.test.ts`: **12/12** — eligibility + hash traceability, unapproved labeling, lifecycle gating, invalidation flags, pipeline validation/history/follow-ups, outcome vocab, draft versioning + approval gate, catalog honesty, RLS + rollback, concurrent single-active, no-delivery scan, DATE-render guard.
- Full `npx vitest run`: **13 files, 187/187** (T-002 SQL + T-003 18 + T-004 30 + T-005 19 + dashboard 7 + auth + gleif 19 + evidence 16 + hypothesis 16 + proposal 14, incl. 5000/5001). `tsc` clean. `npm run build` clean.
- HTTP round-trip on production build: company → evidence → hypothesis → validate → proposal → accept → brief → draft (approve blocked 409) → pipeline → outcome → all pages 200; smoke rows removed in dependency order (seed count 3).
- Defects fixed with evidence: uuid=text join (freshness), draft-unique vs versioning order (supersede-first), audit fidelity, funnel allowlist, scan prose (×2), raw-DATE React crash (data-layer serialization + static guard), port archaeology (stale server killed; smokes re-run honestly), duplicate migration file (removed + history reconciled).
- One transient parallel-load failure observed once (passed alone + on rerun); pools reduced 8/5→3 as mitigation.

## 8. Automated-delivery scan findings

Pattern scan over app/lib/components for sending libraries, protocols, messaging-automation verbs, and browser frameworks: **zero hits**. Draft text (subjects/bodies, "human-send-only" labels) correctly distinguished from executable capability.

## 9. Known limitations and unresolved risks

- D-004/D-005 open (placeholders/ranges; estimation baselines provisional).
- No proposal full-text search; no cross-brief analytics; no reminder delivery (by design).
- Docker Desktop degraded once mid-task (environmental; recovered, volumes intact).
- Operator login still open (local-only posture unchanged).

## 10. Recommended next task

**T-011** — deterministic scoring calibration (D-006) over validated hypotheses; or owner review of `docs/T010_OWNER_DECISIONS.md` first.
