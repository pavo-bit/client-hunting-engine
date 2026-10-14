# T007_EVIDENCE_LEDGER_REPORT — Evidence Ledger, Claim Assessment & Provenance

> Date: 2026-10-13. Stack: Next.js 15.5.27 + Docker Compose postgres:17.11. No scraping, no ML, no outreach changes. Hypotheses/opportunity work explicitly out of scope.

## Verdict: PASS

## 1. Actual schema and architecture changes

- `20261013000008_evidence_assessment.sql`: `snapshot.observed_at` (event time vs `fetched_at` capture time), `claim.predicate` + `needs_review`, 8-status vocabulary (observed/verified/corroborated/inferred/assumed + disputed/withdrawn/superseded; stale computed from `expires_at`), `claim_assessment` (append-only history: from/to, rationale, actor, automatic flag), `claim_evidence` (claim↔snapshot/claim links, polarity, exactly-one-target, no self-links), RLS baseline on both.
- `20261013000009_assessment_delete_policy.sql`: UPDATEs stay forbidden; DELETEs permitted (explicit removal cascades; same rationale as 8c).
- `20261013000010_evidence_cascade.sql`: link rows cascade with company removal (deadlock-free takedown; UPDATE protection untouched).
- `lib/evidence/`: `hash.ts` (canonical url+excerpt sha256), `assessment.ts` (transition map, independence rule, recommend, assess/flag with audit), `ingest.ts` (validation, hash-idempotent snapshots, claim assertion limited to observed/inferred/assumed, evidence attach), `detail.ts` (review aggregate).
- GLEIF runs now capture identity observations (snapshot + observed A/2 claim, registry fields only — never services or problems).

## 2. Files and migrations changed

Created: 4 lib files, 5 API routes (ingest/attach/assess/flag/claim-detail), claim detail page + assess dialog, agency claims section, `tests/evidence.test.ts`, 3 migrations, this report. Modified: evidence ledger filters/statuses, dashboard queries, intake (no contract breaks), docs (model, implementation, plan, D-015).

## 3. Provenance and assessment rules

- Every material claim traces to a snapshot (FK-enforced) with source key, URL, capture/event times, hash, retention, suppression state; missing provenance is reported, not invented.
- Reliability (source A–D) and credibility (claim 1–5) stored and displayed separately; corroboration counts independent `(source, host)` origins, never grades.
- Verified is human-only; automatic transitions limited to corroborated on 2+ independent origins; withdrawn/superseded terminal (new evidence → new claim); rationale always required; contradictions preserved and surfaced; shared-origin repeats never corroborate.

## 4. Ingestion and idempotency behavior

Hash-idempotent snapshots (same content → same row, no duplicate claims); reruns safe; GLEIF identity observations automatic per new company; ingestion rejects bad URLs/oversized excerpts/unknown sources/companies, over-privileged statuses, bad enums.

## 5. Dashboard and API additions

Claim detail (`/evidence/[id]`): statement, status/stale/review badges, provenance, supporting vs contradicting tables, rationale, full history, assess dialog (human statuses + flagging). Ledger filters cover all 8 statuses; rows link to detail; agency pages list claims. Mutating routes token-gated; read routes open per convention.

## 6. Authorization and audit controls

RLS + PUBLIC revokes on new tables (unprivileged denial tested); every assessment/flag/attach writes audit rows; prior assessments immutable (UPDATE blocked, tested); no secrets in evidence paths; excerpts stored verbatim and rendered as quoted untrusted text (React-escaped).

## 7. Tests executed with exact results

- `tests/evidence.test.ts`: **16/16** — hash consistency, validation matrix (incl. verified-at-ingestion rejection), idempotency (counts stable), tri-timestamp distinction, verbatim excerpts, link polarities + single-target + self-link + 404s, independence rule, recommend logic, full lifecycle (observed→auto-corroborated→human-verified, history of 3), terminal states + computed stale, guard matrix (rationale/unknown/no-op), flagging, reliability/credibility separation, takedown suppression, assessment append-only, merge attribution (claims move, snapshots stay), RLS denial.
- Full `npx vitest run`: **10 files, 145/145** (T-002 SQL suite + T-003 18 + T-004 30 + T-005 19 + dashboard 7 + auth + gleif 19, incl. 5000/5001). `tsc` clean. `npm run build` clean.
- HTTP round-trip on production build: ingest → claim → assess(corroborated) → flag → detail 200 + filtered ledger 200; smoke rows removed (seed count 3).
- Mid-task defects (all fixed with evidence): `observed_marker` vs real `observed_at` column, fused comment/statement line, bogus attach stub (split into proper route), `[0]`/`[1]` param-index slip, cascade deadlocks (8g), test-cleanup isolation.

## 8. Regressions, type-check, build

T-002 through T-006 all green in the 145 (one deliberate, documented contract narrowing: bare platform hosts no longer storable as `domain_norm`, from T-004 work). No Supabase, no scraping, no outreach deltas (scans green).

## 9. Known limitations and unresolved risks

- D-008 retention windows still open (classes + suppression exist; windows TBD).
- Plan T-008 retains injection-fixture quarantine for future HTML fetching (JSON-API + quoted-text posture today).
- No full-text claim search; brief→claim→snapshot chain asserted at row level, not via a dedicated chain test.
- Operator login still open (local-only posture unchanged).

## 10. Recommended next task

**T-008** (injection fixtures + quarantine for future untrusted-web fetching), then T-009 profiles/hypotheses.
