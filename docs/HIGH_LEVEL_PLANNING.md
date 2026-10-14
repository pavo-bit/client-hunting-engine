# HIGH_LEVEL_PLANNING — Phases, Milestones, Risks

> No calendar deadlines invented. Exit criteria gate each phase. Related: `LOW_LEVEL_PLANNING.md`, `DECISIONS_AND_OPEN_QUESTIONS.md`.

## 1. Phases

| Phase | Objective | Depends on | Exit criteria |
|---|---|---|---|
| P0 Docs & decisions | This documentation set + initial `D-*` triage | Workspace audit | §14 audit checklist passes; D-001/D-002 decided (worldwide agencies); D-003…D-010 triaged or marked TBD |
| P1 Data foundation | Schema (agency company, snapshot, claim, hypothesis, catalog, brief, outcome, audit) + intake (manual + CSV) + dedup | P0 | FR-001…FR-004 + AC on agency seed data; audit history works |
| P2 Evidence pipeline | Fetch policy, snapshot store, ledger, contradiction surfacing, injection handling | P1 | FR-008…FR-012 demonstrable; G1/G7 pass |
| P3 Opportunity core | Profiles, hypotheses, validation gates, catalog, project options, deterministic scoring/ranking | P2 | FR-013…FR-020; reproducibility check passes |
| P4 Review & learning | Queue, briefs, drafts, outcome/rejection logs, learning reports | P3 | FR-021…FR-025; no-send-path attested |
| P5 Validation | 20 high-quality briefs manually reviewed | P4 | AC-001 passes |
| P6 Scale decision | Add adapters incrementally; slice worldwide agency segment by agency-type/country views | P5 | Explicit `D-*` approvals + thresholds |

## 2. Milestones

- M1: P1 complete — canonical records + provenance on seed data.
- M2: P3 complete — first ranked queue with explanations.
- M3: P5 complete — 20 reviewed briefs; MVP declared per AC-001…AC-005.
- M4 (post-MVP): scale proposal with measured precision/reply data.

## 3. Risk register

| ID | Risk | Mitigation |
|---|---|---|
| R-01 | Source terms/costs block planned adapters; jurisdiction variance under worldwide scope | Per-source fallback to manual entry; incremental priority per D-003 (access/quality/cost/yield); never bypass terms |
| R-02 | Evidence staleness → bad briefs | Freshness/expiry gates; `stale` transitions; learning report tracks stale rate |
| R-03 | False-positive hypotheses (website-absence fallacy; unconfirmed agency-internal claims) | FR-011 rules + contradiction requirement + validation questions in briefs + QA gate G1 |
| R-04 | Prompt injection via fetched content | Quoting discipline, injection fixtures, quarantine + escalation |
| R-05 | Scope creep (SaaS, auto-send, ML, infra) | Locked boundaries + `D-*` change control; no-send-path test |
| R-06 | Overestimated commercial case | Ranges + assumptions mandatory; QA rejects point promises |
| R-07 | Empty-repo schema drift | Single data-model doc owns schema; migrations reviewed against it |

## 4. Validation plan

Seed dataset of worldwide agencies (mixed agency types + countries) → intake checks → evidence completeness audit → scoring reproducibility → brief quality review (G1–G6) → 20-brief manual review → outcome logging → learning report → scale decision.

## 5. MVP completion definition

AC-001…AC-005 in `PROJECT_SPECIFICATION.md` §7 all met, plus docs audit checklist.

## 6. Expansion criteria

New source only when: terms verified, manual fallback defined, evidence quality measured on current set, and a `D-*` decision records rationale + owner. New agency-type/country slices are views on the worldwide agency segment; expansion to non-agency business categories requires its own `D-*` decision.
