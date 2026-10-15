# PILOT READINESS REPORT — verdict: PILOT BLOCKED

> **Date:** 2026-10-15. Prepared, not activated: no pilot starts on the
> strength of this document. Activation requires the owner decisions in §5,
> each recorded with a date in the canonical registers.

## 1. Verdict

**PILOT BLOCKED.** The platform is structurally ready (Discovery → events →
qualification → scoring → review → audit all execute and are tested), but a
pilot that contacts real businesses or claims validated lead quality cannot
start: no approved service is included, no eligibility content exists, no case
has been independently reviewed, and formal validation prerequisites are open.

## 2. Definitions (fixed before any pilot)

- **Included services:** none approved. O9/D-003 per-adapter and D-004 catalog
  decisions are OPEN; the two catalog rows are placeholders.
- **Eligible opportunities:** none while O10 is OPEN — `new_eligible` is 0 by
  design and assessments cannot run in production (no active policy; the
  assess path refuses with 409).
- **Required evidence quality:** undecided (O10/O3) — the machinery enforces
  grades, independence, freshness and contradiction rules, but the bars are
  fixture values, not approvals.
- **Independently reviewed cases:** 0. No blind review has occurred; the gold
  set's second opinions are synthetic format exercises, not review evidence.
- **Baseline methodology:** four rankers over identical pools
  (`lib/eval/baselines.ts`); the generated report
  (`docs/EVALUATION_BASELINE_REPORT.md`) shows synthetic-engine behavior only.
- **A useful lead:** undefined until O10/O3 — the pilot cannot count what it
  has not defined.
- **Acceptable false-positive rate:** undefined (same reason).
- **Exclusion-leakage rate:** must be zero — the one rate already enforced
  (suppressed items never rank; evaluation asserts it).
- **Insufficient evidence:** everything commercial — no outreach has occurred
  (by design), so pursuit-to-conversation and qualified-opportunity rates are
  unmeasured with capture plans documented.

## 3. What the evaluation actually shows (synthetic, n=12)

Held-out split: precision 1.0 at top-10/20 (3 eligible of 4 ranked — wide
uncertainty, stated in the report), leakage 0, stability 1.0 under ±10%
perturbations, reviewer agreement 0/1 (MISS — the single dual-reviewed pair
disagrees BY DESIGN to exercise adjudication; n=1 cannot support a threshold
and none is claimed). Dev split: precision 0.67, agreement 1/2, rest PASS.
These numbers describe engine behavior on constructed fixtures. They are not
lead-quality evidence and must never be cited as such.

## 4. How decisions and outcomes WILL be recorded (mechanism ready, data absent)

Decisions: `p2.case_decision` (immutable, assessment-cited, audited).
Assessments: `p2.case_assessment` (versioned, snapshot-linked). Research:
`p2.research_task` + `p2.negative_finding`. Commercial outcomes: NOT YET —
`outcome_log` has no case link; recording pursuit outcomes requires a schema
decision (proposed: link by case_id) that is itself owner-gated by O11 scope.
Until then, qualified-opportunity and pursuit rates stay UNMEASURED by
construction, not by omission.

## 5. Conditions for a human to authorize the pilot (all must hold)

1. O10 decided → active policy published (explicit operator act).
2. D-004 decision recorded (OPEN until a dated owner reply) → at least one approved service in an active catalog.
3. O1/O2/O3 decided → in-scope pipelines, targets and counting basis.
4. O7 decided (or ranking stays explicitly provisional in the pilot charter).
5. O9/D-003 → pilot adapter set approved with terms verified.
6. O11 + T-014 §12(a)–(e) + R-05 → five approvals + QA attestation recorded.
7. B-D1 → spec canonical question closed.
8. B-D13 → service-identity policy for any machine caller in the pilot loop.
9. Independent blind review of ≥30 pilot-candidate cases with recorded
   disagreements and adjudication (protocol: T-014; current count: 0).
10. Evaluation re-run on the approved policy with thresholds re-declared for
    that policy (thresholds are version-bound, never carried over silently).

## 6. What is NOT blocking (ready now)

Local-only operation · manual triggering everywhere · backup/restore drill ·
migration/permission verification · audit trails · reconciliation/recovery
tooling · the review and research workflows themselves.
