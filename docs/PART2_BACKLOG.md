# PART 2 BACKLOG (authorized planning input — no implementation)

> **Date:** 2026-10-15. Part 2 must not begin until the Part 1 interfaces and
> blockers are reviewed. Every item states its unblock condition. Items marked
> BLOCKED need an owner answer from
> [the decision packet](PART1_OWNER_DECISION_PACKET.md); no item may proceed
> by guessing it.

## P2-01 — Apply the approved eligibility screen (BLOCKED: O10)
Record O10-blessed gates as ONE named policy constant; evaluate the
accumulated `observed` population through `evaluateEligibility`; verify
`new_eligible` becomes non-zero honestly. Files: `lib/discovery/eligibility.ts`
(constant only), assessments via existing paths. No new tables.

## P2-02 — Qualification verdicts on decided cases (BLOCKED: O10)
Once O10 exists, record verdicts as `p2.case_assessment` rows citing the
approved policy version + input snapshot. Workflow moves via `setCaseStatus`.
No new verdict states invented; `assessed` stays workflow state.

## P2-03 — Direct-client pipeline (BLOCKED: O1)
If O1 answers (b): lift the 409 for the approved segment, add taxonomy-aware
handling. Schema already permits the value (no migration). If (a): close as
agencies-only and remove from planning.

## P2-04 — Allocation-aware reporting (BLOCKED: O2/O3)
Apply the approved split to shortfall presentation. Mechanism exists
(per-pipeline rows, never transferred); only the "on target" definition is
missing.

## P2-05 — Coverage planner values (BLOCKED: O4)
Approve N/caps or defer definitively. Stopping-rule machinery exists and
takes caller thresholds; planner defaults are the only missing piece.

## P2-06 — Authorized weighting (BLOCKED: O7/D-006)
Only after frozen-score evidence: cite active `reference_version` rows from
new assessments. Until then any ranking stays explicitly provisional.

## P2-07 — Additional adapters (BLOCKED: O9/D-003, per adapter)
Terms verified + decision entry per adapter, then register in
`lib/discovery/production.ts`. GLEIF stays the only live adapter until then.

## P2-08 — Service identities for machine callers (BLOCKED: B-D13)
Design named service identities AFTER the owner answers B-D13. Until then,
machine paths stay unattributed-by-policy (fail closed).

## P2-09 — Frozen run snapshots (advisory: F18)
Only if a real consumer needs audit-grade frozen `measures`. Default: do not
build; the task ledger + eligibility history already answer "what did the run
intend".

## P2-10 — Reaper heartbeat (advisory: F19)
Only with evidence that threshold-based reaping misfires on healthy slow
runs. Default: operator threshold + dry-run stands.

## P2-11 — Phase 2 read surfaces (IMPLEMENTABLE after P2-01)

> DONE in Part 3 (2026-10-15): `/today`, `/qualification` (+report),
> `/qualification/cases/[id]`, `/qualification/assess`,
> `/qualification/research`, `/qualification/policy` (+capacity),
> `/qualification/audit`, `/admin`, plus the decision/research/reconcile
> routes and components. Remaining UI work (if any) belongs to Part 4
> polish, not to this item.
Case queue, case detail (evidence + snapshots + assessments + drift flags),
reconciliation reports — read-only projections over `p2` + the frozen view.
All authenticated, same-origin guarded, paginated with totals. No new
write paths beyond the existing workflow edges.

## P2-12 — Pilot execution (BLOCKED: O11/T-014/R-05/B-D1)
Formal validation only after all five T-014 §12 approvals, QA attestation,
and the spec-canonical question are resolved. Not plannable further here.

## Explicitly out of Part 2 scope
Autonomous refresh, autonomous outreach, schedulers, ML/LLM scoring, EIP /
VaultForge, external deployment, cloud provisioning, public SaaS surfaces.
Each would need its own recorded decision first (AGENTS.md hard boundaries).
