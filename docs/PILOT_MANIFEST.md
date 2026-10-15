# CONTROLLED LOCAL PILOT — MANIFEST (Master Prompt 3, Phase A)

> **Date:** 2026-10-15. **Status: PILOT NOT STARTED — readiness gaps recorded
> below, pilot activity blocked.** This manifest fixes the baseline before any
> pilot operation. Missing values are recorded as missing; nothing was
> modified to make the baseline cleaner.

## 1. Pilot identity and scope

| Field | Value |
|---|---|
| Pilot identifier | grayscales-local-pilot-001 (reserved — never activated) |
| Start date/time | — (not started; gaps below block start) |
| Repository revision | `54fa1da`, worktree preserved, nothing committed/pushed/deployed |
| Application/database versions | Next.js 15.5.27 / React 19 / PostgreSQL 17.11 (Docker, loopback 127.0.0.1:5434) |
| Active policy version + identity | **NONE** — zero active versions of any kind (read 2026-10-15) |
| Owner approval references | **NONE** — zero dated approvals on record (searched all registers) |
| Approved service catalog version | **NONE** (D-004 OPEN; placeholders only) |
| Approved scoring rubric version | **NONE** (D-006/O7 OPEN; provisional scorecard only) |
| Approved source registry version | 12 categories S-01…S-12 + `gleif-api` connector (structural, verified); adapter priority (D-003) OPEN |
| Approved evaluation protocol version | T-014 protocol EXISTS but NOT STARTED; thresholds in harness are unapproved fixtures |
| Pilot acceptance criteria | T-014 G1-G6 + eval thresholds — proposed, NOT approved (R-05 OPEN) |
| Candidate-pool definition | Accumulated agency-partner opportunities (5 rows, all `observed`, 0 eligible) — pool exists, qualification content does not |
| Segmentation | agency-partner only; `direct_client` refused (409) until O1 — separation enforced by code |
| Sampling/labeling method | Gold v1 (12 synthetic items, dev/heldout) for engine behavior; **no human-labeled pilot sample exists** |
| Operator/reviewer roles | Operator: unnamed single operator (no individual on record); independent reviewer: **NONE assigned** |
| Known defects/limitations | Findings register F/P1/P2/P3 series (closed) + open F18/F19/F22/F23 + L1–L7; multi-active-version latest-wins (procedural gate) |
| Backup/recovery evidence | Drill 2026-10-15: 236,270-byte dump, sha256+TOC ok, scratch restore `{44 migrations, 8 companies, 12 categories, 0 orphans}`, retention 4+legacy |
| Ten authorization conditions | All BLOCKED — see `docs/PILOT_DECISION_RECORD.md` §G |

## 2. Environment verification evidence (Phase B, all read-only or established procedure)

| Check | Command / probe | Result |
|---|---|---|
| Local config | `.env` keys present (names only); Docker Compose PostgreSQL | PASS |
| Loopback bindings | `docker port grayscales-pg` → 127.0.0.1:5434 only | PASS |
| Migrations + integrity | `node scripts/db.mjs verify` (dev) | `verify ok` |
| Records preserved | counts query | 8 companies / 5 opportunities / 0 cases / 0 decisions (unchanged) |
| Backup + restore | `backup.mjs backup/verify/restore` | ok (figures above); scratch dropped |
| No active policy | `reference_version where status='active'` | 0 rows |
| Suppression/audit gates | trigger presence + p2_app zero grants on Discovery tables | guards present, 0 grants |
| No schedulers/outreach | static scan lib/app/scripts (excl. fixtures/tests) | no matches |
| No ML scoring | deterministic engine only; no ML deps | PASS (architecture) |

## 3. Readiness gaps (each blocks the cited pilot activity)

| Gap | Blocks | Remedy (owner action) |
|---|---|---|
| No approved policy/catalog/rubric/capacity (all OPEN — nothing approved, nothing published) | Any assessment, scoring, ranking use | Dated approvals O10/D-004/D-006/O7 + explicit publication |
| No approved services | Pursuit of any lead | D-004 catalog approval |
| No approved eligibility screen | Judging the 50-target; brief entry | Dated O10 reply |
| No independent reviewer assigned | Blind review, agreement metrics, adjudication | Name reviewer(s) + review ≥30 cases |
| No approved acceptance criteria | All Phase E metrics, go/no-go thresholds | R-05 attestation + frozen criteria |
| No validation approvals | T-014 execution, pilot cohort | O11 five approvals |
| No spec-canonical confirmation | Spec-compliance claims | B-D1 file or written confirmation |
| No service-identity policy | Machine-caller audit in any pilot loop | B-D13 policy choice |
| No commercial-outcome linkage | Pursuit/qualified-rate metrics | Schema decision for case-linked outcomes (owner-gated) |
