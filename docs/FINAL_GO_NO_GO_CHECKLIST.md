# FINAL_GO_NO_GO_CHECKLIST — Release Decision Aid

> How to read: INTERNAL USE and EXTERNAL DEPLOYMENT are separate decisions.
> A line may be GO for one and NO-GO for the other. Overall: **GO for
> internal local-only use within limits; NO-GO for external deployment.**

## Internal local-only use — GO (within limits)

- [x] Auth enforced on all pages/API (re-proved 2026-10-14).
- [x] Data integrity + audit provenance green (verify + 300 tests).
- [x] Backup/restore proven locally with timing.
- [x] Health, request IDs, redacted logs, runbook executable.
- [x] Performance within approved capacity (50 projects).
- [x] Pilot shows genuine utility with honest uncertainty.
- [x] No-send + permitted-sources boundaries hold.
- Limits: single operator, loopback only, provisional policies, manual
  backups, manual log inspection, no predictive claims, T-014 sign-off still
  required before scaling research labor.

## External deployment — NO-GO (all must clear first)

- [ ] D-004/D-005/D-006/D-008 owner approvals (OPEN).
- [ ] T-014 sign-off cohort + R-05 QA attestation.
- [ ] Off-host backup custody + schedule + encryption/key custody.
- [ ] Provider-run CI green on a connected remote.
- [ ] MFA + persistent rate limiting (mandatory on exposure).
- [ ] Metrics/alerting beyond manual log inspection (as required by exposure).
- [ ] RPO/RTO accepted by owner against measured numbers.
- [ ] Explicit external-deployment authorization (separate decision).

## Never authorized by this report

Automatic deployment, public ports, cloud provisioning, external backup
vendors without approval, automated outreach, capacity-target expansion,
weight tuning, predictive-accuracy claims.
