# PILOT DECISION RECORD — Ten-Condition Matrix + Formal Go/No-Go (Master Prompt 3, Phases G–H)

> **Date:** 2026-10-15. Pilot `grayscales-local-pilot-001` NOT started.
> This record assesses the ten canonical conditions from
> `docs/PILOT_READINESS_REPORT.md` §5 against current evidence. Previous
> reports are preserved; this record supersedes nothing — it cites them.

## Phase G — Ten-condition authorization matrix

> **Count note (resolved 2026-10-15):** an earlier version of this matrix
> compressed two canonical conditions into row 6 and summarized "zero of
> nine". The canonical pilot report §5 lists TEN substantive conditions; all
> ten are assessed individually below with canonical wording preserved. No
> condition was removed or replaced.

| # | Condition (canonical wording) | Required evidence | Actual result | Status | Remaining action |
|---|---|---|---|---|---|
| 1 | O10 decided → active policy published (explicit operator act) | Dated O10 reply + active `policy` version | No reply; zero active versions | BLOCKED | Owner reply + explicit publication |
| 2 | D-004 decision recorded (OPEN until a dated owner reply) → at least one approved service in an active catalog | Signed D-004 record + active catalog with ≥1 approved service | PENDING record unsigned; catalog table empty on dev | BLOCKED | Owner signature + publication |
| 3 | O1/O2/O3 decided → in-scope pipelines, targets and counting basis | Dated replies | All three OPEN | BLOCKED | Owner replies |
| 4 | O7 decided (or ranking stays explicitly provisional in the pilot charter) | Dated O7 reply or provisional charter | OPEN; provisional only | BLOCKED | Owner reply or charter |
| 5 | O9/D-003 → pilot adapter set approved with terms verified | Per-adapter terms + registration | GLEIF-only; no new terms | BLOCKED | Per-adapter replies |
| 6 | O11 + T-014 §12(a)–(e) + R-05 → five approvals + QA attestation recorded | Five approvals + attestation | None present; T-014 NOT STARTED (guarded) | BLOCKED | All approvals + attestation |
| 7 | B-D1 → spec canonical question closed | File or written confirmation | Neither supplied | BLOCKED | Owner supplies/confirms |
| 8 | B-D13 → service-identity policy for any machine caller in the pilot loop | Dated policy choice | OPEN | BLOCKED | Owner policy choice |
| 9 | Independent blind review of ≥30 pilot-candidate cases with recorded disagreements and adjudication (protocol: T-014; current count: 0) | Review records | Count: 0; no reviewers named | BLOCKED | Name reviewers; run reviews |
| 10 | Evaluation re-run on the approved policy with thresholds re-declared for that policy (thresholds are version-bound, never carried over silently) | Re-run report on approved policy | No approved policy exists; fixture-only synthetic report | BLOCKED | Approvals first, then re-run |

Status key used: PASS / FAIL / BLOCKED / NOT TESTED / INSUFFICIENT EVIDENCE.
No condition reaches PASS. None was replaced with an easier condition.

Readiness split (as required):
- **Technical readiness:** READY — suite/build/verify/backup green; guards enforced; UI operable (with fixtures in test).
- **Policy and governance readiness:** NOT READY — zero approvals, zero active versions.
- **Evidence and ranking quality:** UNPROVEN — synthetic engine behavior only; no blind review.
- **Operational readiness:** READY (local, manual, recoverable) — except reviewer staffing.
- **Pilot authorization:** DENIED (this record).
- **External deployment authorization:** DENIED and out of scope.

## Phase H — Formal decision: NO-GO

- **Blocking conditions:** all ten rows above (G1–G10), each evidenced.
- **Supporting evidence:** registers (all OPEN), zero-active query, empty content tables, reviewer count 0, synthetic-only eval report, BLOCKED pilot report (unchanged and still true).
- **Risk if continued:** contacting real businesses or claiming validated quality on unapproved policy — the exact harm every gate in this repo exists to prevent; plus wasted review effort on uncalibrated ranks.
- **Exact remediation:** the Remaining-action column above, in order 1→10 (policy chain first: O10 → D-004 → scope → weighting → adapters → validation approvals → identity → reviews → re-run evaluation).
- **Responsible owner/role:** unnamed — no individual on record (stated, not invented); no deadline invented.
- **Retest requirements:** re-verify §§B2–B9 environment checks; re-run evaluation on the approved policy with re-declared thresholds; confirm ≥30-case blind review; confirm ten conditions PASS.

**NO-GO — BLOCKERS MUST BE RESOLVED.** No external action, deployment, commit or push occurred. The next phase authorized is owner review — nothing else.
