# T014_VALIDATION_PROTOCOL_PROPOSAL — 20-Brief Validation + MVP Sign-off

> Status: PROPOSED SPECIFICATION FOR REVIEW. T-014 is NOT started. This
> document answers milestone §3 ("if either task lacks a reliable
> specification, write a proposed specification") — the register entry for
> T-014 names the objective and acceptance but no executable protocol.
> Nothing here authorizes beginning the 20-brief labor.

## 1. Objective (from register + spec)

AC-001…AC-005 (`PROJECT_SPECIFICATION.md` §7) on worldwide agency briefs
(mixed agency types + countries): 20 high-quality briefs manually researched
+ reviewed before scaling automation; all FR-001…FR-025 demonstrable on seed
data with provenance intact; no auto-send path (code search + QA attestation);
scoring reproducibility check; docs consistency audit.

## 2. Prerequisites (all must hold before brief #1)

- T-001…T-013 accepted (after this milestone: T-013 completes; T-014 labor unblocked).
- Owner approvals that gate content: D-004 (catalog), D-005 (pricing posture
  at least formalized as ranges-with-assumptions), D-008 takedown handling
  (retention windows may stay provisional, but the takedown path must be named).
- D-006 stays provisional (validation does not calibrate weights).
- AUTH-001 active (all research actions attributed to the signed-in operator).

## 3. Proposed protocol

1. **Sample plan (owner-approved):** 20 agencies spanning ≥4 agency types and
   ≥5 countries; mix of directory-found, GLEIF-found, and manually entered;
   at least 3 with identity conflicts (to exercise review), at least 3 with
   contradictions (to exercise needs_review).
2. **Per-brief gate matrix:** for each brief, record G1–G6 pass/fail with
   evidence pointers (claim IDs, gate outputs, score breakdown, review
   decisions). Any fail blocks that brief — failures are recorded, not waived.
3. **Reproducibility:** re-run scoring on all 20 inputs; byte-identical totals
   required (AC-004). Re-generate the ranking; order stable required.
4. **No-send attestation:** repository scan green (automated) + named human QA
   sign-off with date (AC-003; closes R-05).
5. **Outcome starter log:** record manual outcomes as replies arrive (feeds the
   n≥30 calibration dataset; does not complete it).
6. **Docs audit:** master-prompt §14 checklist re-run (AC-005).
7. **MVP decision record:** PASS / PASS-WITH-FOLLOW-UPS / NOT-YET with the
   follow-up list. Quality shortfall → do not scale (per register risk note).

## 4. Required artifacts (produced during T-014, not now)

- Evidence bundle: 20 brief IDs + per-brief gate matrix + reproducibility log.
- Link audit output (every brief field → evidence → snapshot → source).
- QA attestation (named, dated).
- MVP decision entry in the register.

## 5. Risks

- Research labor is real operator time (est. hours per brief); do not start
  without owner commitment.
- Sparse outcomes: 20 briefs will not reach n≥30 calibration inputs; the
  protocol must not claim otherwise.
- Catalog/pricing provisionals cap commercial depth of the 20 briefs; the
  decision record must state this plainly.

## 6. Approval needed to start

Owner confirms: sample plan, D-004/D-005 posture, QA assignee for attestation,
and acceptance that provisional weights stay provisional through sign-off.
