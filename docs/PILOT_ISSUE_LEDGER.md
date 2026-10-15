# PILOT ISSUE LEDGER (Master Prompt 3, Phase F)

> Opened 2026-10-15 with the controlled pilot NOT started. Every entry below
> is either a previously recorded finding (with its register ID) or a pilot
> readiness gap found in this phase. No pilot-operation issues exist because
> no pilot operations ran. Severities: blocker (stops the pilot) · major
> (degrades a pilot objective) · minor (polish, non-blocking).

| ID | Title | Class | Severity | Status | Evidence / reproduction | Root cause (verified or hypothesis) | Remediation + required approval | Retest |
|---|---|---|---|---|---|---|---|---|
| PI-01 | No approved policy: assessments refuse in production | Unresolved external dependency | blocker | OPEN | zero active versions (read 2026-10-15); assess → 409 (executed proof, prior phase) | Owner decisions O10/D-004/D-006/O7 OPEN | Dated approvals + explicit publication | re-query actives; assess smoke test |
| PI-02 | No independent reviewer: agreement/blind-review metrics unmeasurable | Unresolved external dependency | blocker | OPEN | gold agreement 0/1 by design; reviewer count 0 | No reviewer named (O11) | Name reviewer(s); review ≥30 cases | agreement metric with n≥30 |
| PI-03 | Acceptance criteria unapproved: thresholds are fixtures | Evaluation-design problem | blocker | OPEN | thresholds pre-declared but unapproved; R-05 OPEN | Criteria never frozen | R-05 attestation + frozen list | metrics vs frozen thresholds |
| PI-04 | Commercial-outcome linkage missing (`outcome_log` has no case link) | Data-integrity/operational | major | OPEN | schema inspection; pilot report §4 | Schema predates case model | Owner-gated schema decision + migration | pursuit/qualified rates measurable |
| PI-05 | Multi-active versions resolve latest-wins (no DB invariant) | Implementation defect (minor; deterministic) | minor | OPEN (procedural gate in place) | code read + latest-wins test | No uniqueness rule by design | Procedural exactly-one-active check (done); optional unique partial index (later phase, owner-visible) | activation checklist |
| PI-06 | Small-n gold set; agreement threshold fragile at n=1 | Evaluation-design problem | major | OPEN (reported, not tuned) | generated report: heldout agreement 0/1 MISS | v1 size (12 items, 1 dual-reviewed heldout) | Gold v2 with larger dual-reviewed set; re-declared thresholds | re-run evaluation |
| PI-07 | Review time uninstrumented | Operator usability problem | minor | OPEN | no dwell-time capture in review UI | Never built (honestly absent) | Instrument decision dwell (later phase) | review-time metric present |
| PI-08 | GLEIF-only live population; directory sources fixture-only | Evidence-source/coverage problem | major | OPEN (by design until O9) | 1 live adapter; 5 dev companies all non-US/EU-other_digital | O9/D-003 OPEN | Per-adapter terms + registration | breadth + precision on live pool |
| PI-09 | Registered-company evidence carries no domain (5 GLEIF rows, NULL domains) | Evidence-source/coverage problem | minor | DOCUMENTED (expected behavior) | F17 investigation + verifier NULL-aware check | Registry data model (LEI, not domains) | None — consumers must handle null domains (documented) | — |
| PI-10 | No off-host disaster recovery | Data-integrity/operational problem | major | OPEN (documented limitation) | backup doc §6; local-only constraint | No off-host custody by design | Owner decision if required; until then no DR claims | — |

Closed/transferred: all F/P1/P2/P3 implementation findings (registers — verified
closed, suites green); F18/F20/F23 + L1–L7 remain as documented limitations in
the packet and pilot report.
