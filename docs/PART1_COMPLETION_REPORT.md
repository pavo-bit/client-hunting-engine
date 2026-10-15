# PART 1 COMPLETION REPORT — Discovery Phase 1 Completion, Readiness Audit, and Phase 2 Foundations

> **Date:** 2026-10-15. **HEAD:** `54fa1da` (single commit; nothing committed,
> pushed or deployed by this work).
> Companion: [decision packet](PART1_OWNER_DECISION_PACKET.md) ·
> [interface spec](DISCOVERY_PHASE2_INTERFACE_SPEC.md) ·
> [event contract](PHASE2_EVENT_CONTRACT.md) · [Phase 2 schema](PHASE2_SCHEMA.md) ·
> [Part 2 backlog](PART2_BACKLOG.md).

## 1. Phase 1 completion audit (what was checked, against what)

Audited Discovery against the approved specification using the repository and
the live databases as truth (prior reports treated as historical claims until
reproduced). Scope covered: eligibility rules and exclusion reasons; business
identity resolution and duplicates; evidence provenance, source registration
and freshness; manual refresh execution and bounded runtime; new-vs-existing
counting; history preservation; pagination, totals and caps; API authorization,
same-origin protection and DB permissions; failure recovery, idempotency,
migration safety, backup/restore; operator errors, partial results and run
finalization; and whether tests assert their named criteria.

**Result:** Phase 1 structure was already complete from the prior gate (verified
baseline 35 files / 385 passed / 1 skipped, reproduced in-session). The audit
found **no missing Phase 1 behaviour** — every §3 item maps to implemented,
tested code (traceability: `docs/GRAYSCALES_DISCOVERY_TEST_TRACEABILITY.md`).
What it found instead were five interface/foundation gaps that Part 1 was
created to close (all closed, §2), plus the pre-existing owner blocks (all
still open, §5).

## 2. Issue list (finding, evidence, requirement, fix, test, result)

| ID | Severity | Evidence / affected objects | Requirement | Minimal correction | Regression test | Result |
|---|---|---|---|---|---|---|
| P1-1 | high (integrity) | `discovery_outbox` absent: no event stream existed; Phase 2 had no durable input | §7 durable notifications without a broker | M9: outbox table + guard + `discovery_append_event()` + frozen view; emission wired into the three Discovery writers' transactions | `qualification_events.test.ts` emission block (3) | PASS |
| P1-2 | high (correctness) | `claim_events` failed every call: `ON CONFLICT (consumer_name, outbox_id)` collides with the SELECT outputs, then with the RETURNS TABLE out-params ("could refer to variable or column") | §7 claimable events | M11 (aliased outputs — insufficient) then M12 (bare DO NOTHING + fully qualified refs + the naming convention documented) | claim path in every event test (12) | PASS |
| P1-3 | high (correctness) | brand-new consumer claimed nothing: row-less SELECT INTO leaves the watermark NULL and `outbox_id > NULL` matches nothing | §7 first-claim delivery | M13: one-line `coalesce` default | full probe + event suite | PASS |
| P1-4 | high (concurrency) | second consumer starved: inbox PK was `event_id` alone, so consumer B's delivery hit a PK conflict and got `already_seen` for unseen work | §9 concurrent consumer claims | M15: composite PK `(consumer_name, event_id)` | concurrency test (2 consumers × 2 events, independent watermarks) | PASS |
| P1-5 | medium (correctness) | `last_event_sequence` arrived as text: `max(bigint)` → int8 → driver string, violating the "counts are integers" contract | §6 normalization | M14: drop/recreate view with `::int` + re-issued grants | view contract test | PASS |
| P1-6 | medium (security) | p2_app's granted writes were RLS-denied: enabled RLS with no policy denies even granted roles | §8 permissions | M16: permissive policies for exactly the granted surface | permission suite (6) | PASS |
| P1-7 | high (concurrency) | pool-starvation deadlock: my own `registerOpportunity` rewrite used `pool.query` on the conflict path, so 3 concurrent losers each held a client while waiting for one | Phase 1 no-regression rule | one-word fix back to the held client, with the reason commented | `discovery_opportunities.test.ts` (8×60s timeouts → 9/9 in 2.2s) | PASS |
| P1-8 | low (truthfulness) | `registerOpportunity`'s two writes auto-committed separately: a crash between them left an opportunity with no audit row (and now, potentially, no event) | §4 preservation + §7 atomicity | transaction around row + audit + event | existing suites (conflict path covered) | PASS |

Stale-report corrections made along the way (F12 class, audit records
preserved): contract as-built notes were already current; the Prompt-5 report
correction block stands; new docs link rather than duplicate.

## 3. Migrations applied (forward-only, none edited after apply)

| File | Purpose | Test | Dev |
|---|---|---|---|
| `20261015100001_discovery_phase2_interface.sql` (M9) | outbox + guard + append function + frozen view + p2_app view grants | applied | applied |
| `20261015100002_phase2_foundation.sql` (M10) | p2 schema (8 tables), guards, claim/ack functions, p2_app domain grants | applied | applied |
| `20261015100003_fix_claim_events.sql` (M11) | first arbiter repair attempt (insufficient — see P1-2) | applied | applied |
| `20261015100004_fix_p2_function_ambiguity.sql` (M12) | qualified refs + bare conflict + convention | applied | applied |
| `20261015100005_claim_watermark_default.sql` (M13) | first-claim default | applied | applied |
| `20261015100006_view_sequence_int.sql` (M14) | integer sequence + re-issued grants | applied | applied |
| `20261015100007_inbox_per_consumer_key.sql` (M15) | composite inbox PK | applied | applied |
| `20261015100008_p2_principal_policies.sql` (M16) | p2_app RLS policies | applied | applied |

`MIGRATION_COUNT` 34 → 42. One near-miss is recorded honestly: after M10 was
applied I edited its file (scalar cleanup in `ack_event`), caught it on
re-read, reverted byte-for-byte BEFORE any further apply, and proved the
applied version's behaviour by execution instead. The ledger was never
rewritten and no applied migration differs from its file
(mtime-precedes-applied_at holds for all eight).

## 4. Verification evidence (commands run, actual output)

| Check | Command | Result |
|---|---|---|
| New suites | `vitest run qualification_{view,events,permissions,reconcile}` | 9 + 12 + 6 + 10 = **37 passed** |
| Adjacent suites | + opportunities, eligibility ×2, provenance, counters, planning, conflicts | **73 passed, 11 files** |
| Type check | `tsc --noEmit` (repeated) | clean |
| Operator script | `qualify.mjs status/backfill --target test` | exit 0, correct JSON |
| Schema verify, dev (live data) | `db.mjs verify` | `verify ok` (8 companies, 10 claims, 5 opportunities) |
| Schema verify, scratch | migrate-forward (8) then `verify` | `verify ok` |
| Full suite + build | (final gate run, §7) | recorded below |

## 5. Remaining blockers (accurate, not resolved)

Owner: O1, O2, O3, O4, O7, O10, O11, T-014 §12(a)–(e), R-05, D-004/005/006/008,
B-D1, B-D13 (new), F18 (advisory). Details, options and recommendations in
the [decision packet](PART1_OWNER_DECISION_PACKET.md). Deferred (not
blocking): D-004 catalog/pricing/retention proposals for later stages,
O5/O6/O8/O9, F19/F22, limitations L1–L7.

## 6. Frozen boundary (what Phase 2 gets)

- Read: `v_opportunity_for_qualification_v1` (42 columns, spec
  `DISCOVERY_PHASE2_INTERFACE_SPEC.md`).
- Consume: `p2.claim_events` / `p2.ack_event` (contract
  `PHASE2_EVENT_CONTRACT.md`).
- Own: the `p2` schema (doc `PHASE2_SCHEMA.md`).
- Operate: `scripts/qualify.mjs` (explicit operator commands only).
- Never: direct Phase 2 writes to Discovery records (denied at the DB level
  and proven by test).

## 7. Final gate numbers

Recorded here after the last code change (no database or Docker activity
concurrent with the suite):

- Full suite `npx vitest run`: **43 files, 458 passed, 1 skipped (459), 0
  failed** (317.9 s). The single skip is the opt-in live-GLEIF smoke
  (`GLEIF_LIVE_SMOKE=1`, real network I/O — not executed).
- `npx tsc --noEmit`: clean (run repeatedly, including after the last edit).
- `npm run build`: `✓ Compiled successfully in 76s`.
- No lint script exists in `package.json` (scripts: dev, build, start,
  typecheck, test, db:*) — nothing skipped silently.
- `node scripts/db.mjs verify` on dev (live accumulated data): `verify ok`.
- `node scripts/db.mjs verify` on the isolated scratch database (migrated
  forward, seed intact): `verify ok`.
- Baseline figures (35 files / 385 passed) are the prior gate's historical
  claim, reproduced here only in the sense that every one of those suites
  passes in the final run above. This task's own contribution is exact: **+4
  suites, +37 tests** (`qualification_view` 9, `qualification_events` 12,
  `qualification_permissions` 6, `qualification_reconcile` 10). No
  pre-existing test was weakened, deleted or renumbered; the only touches to
  existing suites are the migration-count bumps in `seed.test.ts`.

One intermediate failure occurred and is recorded, not hidden: during a
mid-task batch run, `discovery_opportunities.test.ts` hung (8×60s timeouts) —
root-caused to a pool-starvation deadlock my own `registerOpportunity`
rewrite introduced (P1-7), fixed the same session, file green in 2.2s since.
A stale background run from that incident also reported failures after its
backends were deliberately terminated; it is superseded by the clean final
run above.

## 8. Verified facts vs unverified historical claims

**Verified in-session (executed):** baseline suite totals; all Phase A
acceptance items; the five P1 defects and their fixes (each with a failing
intermediate state observed, not assumed); migration ledger state on dev,
test and scratch; grant tables (`column_privileges` 41, routine grants 2);
the outbox/view/p2 objects' existence and behaviour; backup/restore drill
(from the prior gate, re-recorded if re-run); worktree state (nothing
committed/pushed).

**Unverified historical claims (not re-run, stated as such):** the live GLEIF
smoke (opt-in, network); end-to-end HTTP smoke against `next start` (covered
instead by direct route-handler tests); real-world discovery precision and
coverage (not provable by a local suite — the "≥50 eligible" target is
unverifiable until O10, not met).

## 9. Change inventory (this task)

Migrations M9–M16 (8 files) · `lib/discovery/events.ts` (new) ·
`lib/discovery/{opportunities,eligibility}.ts` (transactional emission) ·
`lib/qualification/` (5 files, new) · `scripts/qualify.mjs` (new) +
`scripts/db.mjs` (p2_app role in bootstrap) · `tsconfig.json`
(`allowImportingTsExtensions` for the operator script) ·
`tests/qualification_*.test.ts` (4 files, 37 tests) ·
`tests/seed.test.ts` (count 42) · `db/tests/t002_verify.sql` (§9–§10) ·
docs: PART1_COMPLETION_REPORT, PART1_OWNER_DECISION_PACKET, PART2_BACKLOG,
DISCOVERY_PHASE2_INTERFACE_SPEC, PHASE2_EVENT_CONTRACT, PHASE2_SCHEMA (new);
FINDINGS_REGISTER, TEST_TRACEABILITY, RUNBOOK, blockers/O-registers (updated).
Pre-existing work (login, AUTH-001, Discovery, `Creative Login Form/`)
preserved and untouched.
