# OUTSTANDING_DECISIONS_AND_RISKS — Consolidated Register

> Single view of everything still needing a human. Statuses change ONLY via
> dated owner replies recorded in `docs/DECISIONS_AND_OPEN_QUESTIONS.md`.
> Anything marked anything-but-OPEN here without such an entry is a defect —
> `tests/docs_consistency.test.ts` enforces this for D-004/005/006/008.

## Decisions awaiting the owner

| ID | Question | Blocks | Approval-ready record | Status |
|---|---|---|---|---|
| D-004 | Catalog content (service lines) | Commercial depth of briefs; catalog queue stays populated | `D004_…_DECISION_RECORDS.md` §D-004 | OPEN |
| D-005 | Pricing posture (ranges vs rate card, floor) | Quotability; T-014 commercial cases | Same doc, §D-005 | OPEN |
| D-006 | Scoring weights/bands/gates changes | Any tuning; calibration needs n≥30 first | Same doc, §D-006 | OPEN |
| D-008 | Retention windows + legal reviewer + purge-job build | Any deletion automation; social/PII accumulation | Same doc, §D-008 | OPEN |
| T-014 start | Sample plan, D-004/005 posture, QA assignee, weights acceptance, labor | Sign-off cohort (pilot done, non-sign-off) | `T014_VALIDATION_PROTOCOL.md` §12 | NOT STARTED |
| R-05 | Named, dated QA attestation (AC-003) | MVP sign-off | T-014 protocol §12(c) | Outstanding |
| RPO/RTO | Accept ≤24 h / ≤15 min proposals vs ~3 s measured local | Any DR claim | `DATABASE_BACKUP_RESTORE.md` §4 | Proposed |
| Off-host custody | Designate destination + encryption + key holder + schedule | Disaster recovery | `DATABASE_BACKUP_RESTORE.md` §5–§6 | None exists |
| Provider CI | Connect remote; first green provider run | External confidence | `.github/workflows/quality-gates.yml` | Unvalidated |
| MFA/persistent limits | Required on any exposure (evaluated, deferred for local-only) | External deployment | Readiness report §2 | Deferred |

## Risks (all open, all owned)

| Risk | Trigger | Mitigation today | Owner action |
|---|---|---|---|
| Host/disk loss destroys data + local backups | Any hardware failure | Local restore proven (not DR) | Approve off-host custody |
| Quadratic 5000-row import (~2 min) | Large imports | Correct + bounded; 500-row NFR holds | None (accepted limitation) |
| Single-origin thin evidence | Sparse research | Deferrals + insufficient-data states | Fund research depth (T-014) |
| Observer bias (single operator) | Validation judgments | Disclosed; dual-review where staffing allows | Name QA assignee |
| In-memory rate ledger resets on restart | App restart | Documented; lockouts are short-lived | Approve persistent ledger if exposure |
| No metrics/alerting | Silent degradation | Manual log inspection; health endpoint | Approve monitoring on exposure |
| Vitest-chain + postcss advisories | Dev/build toolchain | Accepted risks (breaking-major fixes deferred) | Revisit on vitest-5 / Next-16 |
| Social/PII snapshot accumulation | Time | No purge jobs (correct until D-008) | Approve D-008 |
