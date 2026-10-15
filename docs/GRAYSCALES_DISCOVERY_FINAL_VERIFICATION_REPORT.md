# GRAYSCALES DISCOVERY — FINAL VERIFICATION REPORT

> **Date:** 2026-10-15 · **Scope:** Discovery completion + Phase-2 readiness gate
> **Working tree at time of writing:** `HEAD = 54fa1da`, 1 commit, nothing
> committed/pushed/deployed by this work. All prior user work preserved
> (see §9 change inventory).
>
> **Every number in this report comes from a command executed in this session.**
> Where a check was NOT executed, it says so. Where a finding remains open, it
> is listed as open rather than described as done.

---

## 1. Verification verdicts (Phase A — what actually exists)

| # | Requirement verified | Evidence | Result |
|---|---|---|---|
| 1 | Overall refresh deadline + terminal state | `lib/discovery/refresh.ts` (`DEFAULT_REFRESH_BUDGET_MS = 120_000`, deadline checked before every claim, unstarted tasks → `failed`, parent → `cancelled`); `tests/discovery_refresh_deadline.test.ts` (7 tests, injected clock) | **PASS** |
| 2 | New eligible vs promoted counting | `refreshSummary` groups `public.opportunity` by `status`; `new_eligible` = status `eligible`, `promoted` = status `promoted`. Live projection, now labelled `measures_basis: "live_projection"` (F8) | **PASS (semantics labelled)** |
| 3 | Evidence-update + duplicate counting | `duplicates` = rows in `discovery_run_item` with `status='duplicate'` for child runs; `new_evidence` = distinct claims created inside the run window. Both from immutable stored rows; proven stable in `tests/discovery_counters.test.ts` | **PASS** |
| 4 | Identity-conflict persistence + review | M7 table, `lib/resolve/conflicts.ts`; capture idempotent per (run, record), decisions one-shot with actor + reason + audit row; `tests/identity_conflict.test.ts` (4 tests) | **PASS** |
| 5 | Source-permission enforcement | `assertSourceEnabled` in `run.ts` before any write; fail-closed on unknown key; `tests/discovery_sources.test.ts` | **PASS** |
| 6 | Operator auth, CSRF, authorization, attribution | `lib/auth/guard.ts` single entry point; 401/403 shapes pinned; actor precedence pinned by `tests/discovery_routes_security.test.ts` R6 | **PASS** |
| 7 | Idempotent persistence + retry | `UNIQUE (pipeline, opportunity_key)` + `on conflict do nothing`; discovery dedup on `(source_key, source_record_id)`; E14 rerun evidence | **PASS** |
| 8 | Accumulated history preserved | No deletion trigger on `opportunity`; schema check in the verifier; 60-row accumulation test (R5); GLEIF companies accumulated in dev are untouched | **PASS** |
| 9 | UI visibility, pagination, filters, shortfall | `/discovery`, `/opportunities`, `/opportunities/[key]`; `?limit/?offset/q/status/pipeline`; shortfall rows per pipeline, never transferred | **PASS (code + API contract)** |
| 10 | API response contracts + run-status semantics | `docs/GRAYSCALES_DISCOVERY_API_CONTRACTS.md` updated in §7 below; every new field tested | **PASS after this patch** |

### Accidental total-opportunity cap: none found

- Verified by test (`R5`): 60 opportunities registered in one burst, all 60
  stored, all retrievable across three pages, `total` reported honestly.
- Verified by schema (`db/tests/t002_verify.sql` §8): no `DELETE`/`TRUNCATE`
  trigger on `public.opportunity` and no count-shaped CHECK. A new verifier
  block now fails the build if either appears.
- Verified by inspection: no `LIMIT` in any opportunity write path; `limit`
  exists only as a per-page/per-response clamp.

### Ground truth vs documentation

`docs/DISCOVERY_READINESS_REPORT_PROMPT5.md` still says **31 files / 354 tests**.
Executed baseline at the start of this gate: **35 files / 385 passed / 1
skipped**. The report is stale (F12); §7 below records the correction and what
else in it is superseded. Historical reports were **not** rewritten — they are
audit records.

---

## 2. Phase B — findings addressed in this patch

Each entry: confirmed the finding still existed → root cause → authorization →
change → regression evidence.

### F3 — Eligibility history append-only · **FIXED (previous patch), re-verified**
`opportunity_eligibility` had no database-level guard. Migration M8
(`20261014190008_eligibility_append_only.sql`) applies the established T-007
variant: UPDATE forbidden for every role, DELETE permitted only as the cascade
consequence of removing the parent opportunity.
Evidence: `tests/discovery_eligibility_appendonly.test.ts` (5 tests) plus an
executed negative control — with the trigger dropped inside a rolled-back
transaction the same UPDATE succeeded on 1 row, proving the trigger is the
protection. No rows were modified; M8 is additive and forward-only.

### F4 — Reaper vs in-flight worker · **FIXED (previous patch), re-verified**
`tests/discovery_reap_race.test.ts` (6 tests) proves R1–R4 for worker-first,
reaper-first, simultaneous, end-to-end mid-task, dry-run and missing-actor
cases. The one real remaining defect (the worker reporting its own local status
after a refused finalization) was fixed with `readRunStatus`; reverting that
line makes the end-to-end test fail with `expected 'partial' to be 'failed'`.

### F5 — Non-atomic planning · **FIXED**
**Root cause:** `planRefresh` auto-committed one INSERT per task. A failure on
task N left a *partial* plan stored — the run looked planned and would execute
the wrong work.
**Change:** the run-existence check and all task INSERTs now run in one
transaction (`lib/discovery/coverage.ts`); all-JS validation still happens
before the connection is taken.
**Regression:** `tests/discovery_planning.test.ts` injects a failure on the Nth
task INSERT through a pool wrapper (no timing dependence). Without the
transaction, 1 and 2 task rows leaked and the test failed (`expected 1 to be 0`).

### F6 — Orphaned parent run · **FIXED**
**Root cause:** the parent run row is created *before* planning. If planning
threw, nothing ever finalized it — it stayed `running` until the reaper.
**Change:** `runRefresh` catches any planning failure, closes the parent as
`failed` with the reason (`plan could not be stored: …`) and re-throws the
original error, so the caller still sees the real cause.
**Regression:** same file — parent asserted `failed` with `finished_at` set,
zero task rows, zero child runs, for a failure on task 1 and on task 3 of 4.

### F7 — `unresolved` counter semantics · **DOCUMENTED + SPLIT (additive)**
`unresolved` added "opportunities awaiting review" to "unfinished plan work" —
two different things with different owners. **No public semantic was changed.**
`refreshSummary.measures` now also returns `unresolved_opportunities`,
`unresolved_tasks` and keeps `unresolved` as their exact sum.
**Regression:** `tests/discovery_counters.test.ts` asserts the arithmetic
identity against the database, and that the task half is zero for a finished
run while the opportunity half equals the count of `observed` rows.

### F8 — Historical counter reproducibility · **DOCUMENTED + LABELLED (additive)**
Every measure is a *live projection* computed at read time: promoting an
opportunity today reduces `new_eligible` for a run that finished last week.
This is inherent to the design (opportunity status is current state, not run
history), and the honest fix is to say so rather than fake a frozen snapshot.
**Change:** `measures_basis: "live_projection"` is now returned on every
summary, and the contract document states exactly which counters are frozen
(task ledger: `coverage.yield_new`, `yield_total`, statuses) versus live.
**Recommendation for Phase 2:** read run intent from the **task ledger** and the
**append-only `opportunity_eligibility` history**, never from a past run's
`measures`. Making `measures` frozen would require new snapshot rows — an owner
decision, not a silent change.
**Regression:** `tests/discovery_counters.test.ts` performs the promotion
transition on a historical run and asserts both the moving projection *and* the
untouched frozen ledger.

### F9 — Service-token attribution · **VERIFIED; policy BLOCKED (owner)**
**Finding:** verified, not assumed. Every Discovery route uses
`auth.email ?? actorOf(body)`, and `auth.email` is **never null** when `auth.ok`
is true (three success paths: session email, dev-open operator, configured
service identity). So the body fallback is dead code on these routes and a
caller-supplied `actor` cannot reach the database.
**Regression:** `R6` reaps a stale run over HTTP with
`{"actor":"attacker@example.com"}` in the body and asserts the audit row actor
is the session operator, not the body label.
**Blocked:** what identity a *bearer service credential* should carry is a
service-identity policy. Changing it is an owner decision; recorded as **B-D13**
and deliberately not invented.

### F10 — Identity-conflict attribution · **VERIFIED + made explicit**
`identity_conflict` has no actor column **by design**: a capture always happens
inside a run, and the run records its creator. A second copy of the same
caller-supplied label would add redundancy, not truth.
**Change:** added `conflictAttribution(pool, id)` returning
`{runId, capturedBy, runStatus}` so attribution is a supported, tested read
instead of an ad-hoc join. **Regression:** new test in
`tests/identity_conflict.test.ts`. Whether `capturedBy` is a *verified human*
remains blocked behind F9/B-D13.

### F11 / F17 — Schema verification and seed assumptions · **FIXED**
**Root cause:** the canonical verifier hard-coded `count(company) = 3` and
`count(claim) = 5` — true only on a pristine database. It therefore reported a
false FAILURE on the dev database, whose 5 extra companies are real GLEIF
discoveries kept as evidence. "Fixing" it by deleting companies would have
destroyed product data, which is forbidden and wrong.
**Change (verification, not deletion):**
- Seed verification is now **identity-based**: each seeded company must exist
  with its seeded id + `domain_norm`, the seeded claims must exist attached to
  the seeded company, the seeded hypothesis links must exist in both
  polarities, the seeded contradicting claim must not have been rewritten.
  Counts are still reported as evidence, just not asserted.
- `count(distinct domain_norm)` now excludes NULLs — discovered while
  verifying: **the five GLEIF companies have `domain_norm = NULL`** (the LEI
  dataset carries registry identity, not domains). That is legitimate data.
- New §6 asserts Discovery **structure**: table existence, opportunity unique
  constraint and `run_id`, eligibility uniqueness + CHECK, conflict capture
  uniqueness, coverage-task status CHECK + `finished_at` CHECK + index, all
  four guard triggers **present and enabled**, RLS enabled on all eight
  Discovery tables, no `PUBLIC` grants, no delivery-like table.
- New §7 proves the unprivileged role is denied on the four new tables.
- New §8 proves no accumulation cap can hide in the schema.
- Header documents the correct targets and the scratch-database procedure.

### F12 — Report freshness · **CORRECTED (see §7 and §8)**
`DISCOVERY_READINESS_REPORT_PROMPT5.md` numbers were stale. A dated correction
block was added at the top of that report pointing here; its body was left
untouched as an audit record.

### F13 — `"unknown-source"` provenance fallback · **FIXED**
**Root cause:** when a new item's stored `discovery_record` could not be found,
the loop substituted the literal string `"unknown-source"` and registered the
opportunity anyway. The source key is part of `opportunity_key` — the row's
permanent unique identity — so the fallback *fabricated provenance* that could
never be corrected without a migration, and could collide across unrelated
sources sharing a record id.
**Change:** new exported `attributeNewItem()` fails closed: it registers only
when the stored source key resolves, otherwise it returns `unattributed`,
writes nothing, and the count is surfaced in the refresh result
(`unattributedSourceRecords`) **and in the durable task note**.
**Data impact:** checked both databases before changing code — **zero**
opportunities exist with an `unknown-source` key, so no repair was needed.
**Regression:** `tests/discovery_provenance.test.ts` (5 tests): resolved key,
missing record, NULL source key, skip cases, and an end-to-end refresh proving
keys carry the real source.

### F14 — API security/contract tests · **FIXED**
Five Discovery/opportunity routes shipped in Prompt 5 with no route-level tests.
`tests/discovery_routes_security.test.ts` adds **20 tests**: 401 for anonymous
on all five routes (no data leak, no writes), CSRF 403 + a positive control on
both POST routes, cross-origin refusal, malformed-input handling (400/404/422
with documented codes), response-shape assertions, the 60-row no-cap proof, and
the F9 attribution precedence proof. **No authentication was weakened to make a
test pass** — the two CSRF tests assert the 403 shape specifically so an
anonymous 401 can never be mistaken for CSRF protection.

### F15 — Login asset provenance/licensing · **DOCUMENTED (owner confirm open)**
`public/creative-login/script.js` and `style.css` are byte-identical copies of
the owner's own demo folder in this repository (SHA-256 asserted by
`tests/creative_login.test.ts`). Verified facts: **no licence file exists
anywhere in this repository**; the animation runs on pinned `gsap` 3.13.0,
which declares GSAP's standard "no charge" licence (satisfies local internal
use, restricts redistribution); the app is local-only and distributes nothing.
`PROVENANCE.md` now records the licensing *status* and the one open owner
action: confirm the demo is work the owner may bundle. **No asset was removed,
moved or edited.**

### F16 — `app/agencies/loading.tsx` deletion · **DOCUMENTED (test already pins it)**
Impact: a `loading.tsx` boundary makes Next stream the shell with status **200**
before the page's `redirect()` runs, so an unauthenticated request to
`/agencies` received `200 + loading skeleton` instead of `307 → /login`. No
agency data leaked (verified when found). The file is deleted and
`tests/creative_login.test.ts` now walks `app/` and fails if any `loading.tsx`
reappears anywhere. This was an authorization fix that rode along in the login
task; it is recorded here so it is not mistaken for a redesign.

---

## 3. Phase C — acceptance coverage (what is proven, by which test)

| Acceptance requirement | Test | Status |
|---|---|---|
| Refresh completes inside the approved 120 s budget | `discovery_refresh_deadline.test.ts` (7) | TESTED (documented in-flight overshoot limit stands) |
| Parent and child run states stay consistent | `discovery_reap_race.test.ts`, `discovery_refresh_deadline.test.ts` | TESTED |
| Retries create no duplicates and no duplicate audit | `discovery_refresh_deadline.test.ts` F1.6/F1.8, `discovery_routes_security.test.ts` R5 | TESTED |
| Partial planning never leaves a misleading parent | `discovery_planning.test.ts` (6) | TESTED |
| Concurrent refreshes follow the approved policy | Concurrent refreshes are **permitted** (no single-active-run policy exists); `SKIP LOCKED` claiming prevents double-claim | TESTED (permitted path) — policy question still open with the owner |
| Existing observations preserved / new evidence does not overwrite | E6 in `discovery_e2e.test.ts`, `evidence.test.ts` | TESTED |
| Identity collisions stay reviewable | `identity_conflict.test.ts` (4) | TESTED |
| No auto-merge on name similarity alone | `normalizeName` suffixes handled; conflicts route to review, never merge | TESTED |
| Source provenance attributable | `discovery_provenance.test.ts` (5) | TESTED |
| New eligible vs promoted distinguished | `discovery_counters.test.ts` | TESTED (structure) — **content blocked by O10** |
| Duplicates/evidence never count as new opportunities | `discovery_counters.test.ts` | TESTED |
| Agency vs direct-client kept separate | Schema allows both, app refuses `direct_client` with 409 (O1) | TESTED (structure) — **blocked by O1** |
| Shortfalls reported honestly | `R4` shortfall assertions; `shortfallReport` never nets pipelines | TESTED |
| Unresolved policy decisions stay blocked | No eligibility policy or weights invented anywhere | TESTED (absence) |
| Unauthorized API access rejected | `discovery_routes_security.test.ts` R1 | TESTED |
| CSRF on authenticated mutations | R2 (403 + positive control) and E17 | TESTED |
| DB privileges + append-only protections | `discovery_eligibility_appendonly.test.ts`, verifier §6/§7 | TESTED |
| Schema verification covers Discovery | Verifier §6–§8 executed on dev **and** pristine scratch | TESTED |
| Local backup and isolated restore | `scripts/backup.mjs` | **executed this gate** — dump 1.58 MB, sha256 verified, restore into a scratch DB in 5.0 s, integrity checked, scratch dropped (§8) | TESTED |

### What cannot be verified by a local suite (stated plainly)

A green suite does **not** prove real-world discovery precision, source coverage
or eligibility quality. Two product-level targets are therefore **unverified**,
not met:

1. **"≥ 50 genuinely new eligible opportunities per manual refresh"** — the
   *mechanism* can carry it (25 tasks × 3 pages × 25 records per refresh; no cap
   anywhere), but nothing can currently produce an *eligible* opportunity: the
   eligibility screen's content is O10-gated and deliberately unimplemented, so
   opportunities land as `observed` and `new_eligible` is 0 by design.
2. **Discovery breadth** — one live adapter (GLEIF). Directory-style sources
   exist only as a deterministic fixture. O9/D-003 decide what is added next.

---

## 4. Phase D — executed evidence

Commands run in this session, with their actual output:

| Command | Result |
|---|---|
| `npx vitest run` (baseline, before changes) | **35 files, 385 passed, 1 skipped (386)** |
| `npx vitest run tests/discovery_planning.test.ts` | 6 passed |
| `npx vitest run tests/discovery_provenance.test.ts` | 5 passed |
| `npx vitest run tests/discovery_counters.test.ts` | 4 passed |
| `npx vitest run tests/discovery_routes_security.test.ts` | 20 passed |
| `npx vitest run tests/identity_conflict.test.ts` | 4 passed |
| `npx vitest run tests/discovery_reap_race.test.ts …` (4 files) | 27 passed |
| `npx tsc --noEmit` | clean (no output), run repeatedly |
| `node scripts/db.mjs verify` (dev, live accumulated data) | **verify ok** (previously FAILED) |
| `node scripts/db.mjs verify` (isolated scratch: bootstrap → 34 migrations → seed) | **verify ok** |
| `node scripts/db.mjs verify --target test` | FAILS by design — the test database is migrate-only and holds no seed (documented in the verifier header) |
| `node scripts/backup.mjs backup` + `verify` + `restore --scratch …` | backup/verify/restore drill — see §8 |
| `npx vitest run` (final) | **39 files, 421 passed, 1 skipped (422)** |
| `npm run build` | `✓ Compiled successfully in 25.7s` |

Final full-suite, build and lint results are in §8 (executed after the last
code change).

---

## 5. Phase E — owner decisions and blockers (unchanged, nothing self-approved)

| ID | Question | Status | Consequence for Phase 2 |
|---|---|---|---|
| O1 | Direct-client pipeline in scope? | **OPEN** | `direct_client` rows are refused (409). Phase 2 must plan for agency-partner only. |
| O2 | 25/25 pipeline allocation approved? | **OPEN** | No allocation logic exists; shortfalls are reported per pipeline, never transferred. |
| O3 | §4A counting measures + 50-target basis accepted? | **OPEN** | The 50-target remains unmeasurable. |
| O4 | Coverage-planner scope / stopping values? | **OPEN** | Planner ships with caller-stated thresholds only; no defaults invented. |
| O5–O9 | Catalog/pricing/scores/retention/adapters | **OPEN** | See `docs/DISCOVERY_OWNER_DECISIONS_O1_O11.md`. |
| O10 | Eligibility criteria per pipeline | **OPEN** | `new_eligible` stays 0; `B-D7` stays blocked. |
| O11 + T-014 §12(a)–(e) | Pilot thresholds, ground-truth independence, QA assignee | **OPEN** | Formal pilot cannot start; `B-D10` stays blocked. |
| D-004/005/006/008 | Catalog, pricing, scoring weights, retention windows | **OPEN** | Scores stay provisional; no purge automation permitted. |
| R-05 | Pilot protocol sign-off | **OPEN** | Formal validation blocked. |
| B-D1 | Canonical `.docx` spec absent | **OPEN** | No claim of full spec compliance can be made. |
| **B-D13 (new)** | Service-identity policy for bearer credentials (F9/F10) | **OPEN** | Attribution is trustworthy only for session-authenticated operators. |

Readiness layers are kept separate on purpose: a locally passing suite is
**structural** and **local operational** evidence only. It is not real-world
discovery precision, and it is not pilot evidence.

---

## 6. Phase F — Phase-2 handoff

See `docs/GRAYSCALES_PHASE2_TECHNICAL_HANDOFF.md` (created with this report).
No Phase-2 code, tables or scoring algorithms were created.

---

## 7. Documentation corrections made (F12)

- `docs/DISCOVERY_READINESS_REPORT_PROMPT5.md` — dated correction block added at
  the top: its 31/354 figures are superseded by the executed totals here; the
  body is preserved as an audit record.
- `docs/GRAYSCALES_DISCOVERY_API_CONTRACTS.md` — as-built fields now documented:
  `stoppedBy`, `finalized`, `unattributedSourceRecords`,
  `unresolved_opportunities`, `unresolved_tasks`, `measures_basis`, and the
  actual `GET /api/opportunities` item shape (the draft shape in that file was
  aspirational and never matched the implementation).
- `db/tests/t002_verify.sql` — header documents the correct targets and the
  scratch-database procedure.
- `public/creative-login/PROVENANCE.md` — licensing status recorded (F15).
- `docs/RUNBOOK.md` — scratch-database verification procedure added.

---

## 8. Final numbers (executed after the last code change)

| Check | Command | Result |
|---|---|---|
| Full test suite | `npx vitest run` | **39 files, 421 passed, 1 skipped (422), 0 failed** (152.9 s) |
| Type check | `npx tsc --noEmit` | clean, no output |
| Production build | `npm run build` | `✓ Compiled successfully in 25.7s` |
| Lint | — | **no lint script exists in `package.json`** (scripts: dev, build, start, typecheck, test, db:*). Nothing was skipped silently. |
| Schema verification, dev | `node scripts/db.mjs verify` | `verify ok` — with 8 live companies, 10 claims, 5 opportunities |
| Schema verification, pristine | bootstrap → `migrate` (34) → `seed` → `verify` on `agency_intel_scratch` | `verify ok` |
| Backup | `node scripts/backup.mjs backup` | `agency_intel-20261015-014034.dump`, 1 581 056 bytes, sha256 `c17e598a3fd7bb16…` |
| Dump integrity | `node scripts/backup.mjs verify <file>` | sha256 matches manifest; TOC readable, 258 entries |
| Isolated restore drill | `node scripts/backup.mjs restore <file> --scratch agency_intel_restore_drill` | `restore ok` in 5.0 s; integrity `{migrations:34, companies:8, claims:10, source_categories:12, audit_rows:112, orphan_claims:0}`; scratch dropped afterwards; dev untouched |

Baseline for comparison: at the start of this gate the suite was 35 files /
385 passed / 1 skipped. Net effect of this patch: **+4 files, +36 tests, 0
failures.**

### The one skip
`tests/gleif.test.ts` → 1 skipped: the **live GLEIF smoke** is opt-in
(`GLEIF_LIVE_SMOKE=1`) because it performs real network I/O against the public
open-data API. It was **not** executed in this gate. Every other test in that
file (18) executes offline against recorded/replayed data and passes.

### One failure that occurred, and what it was
During an intermediate full-suite run, `tests/milestone3_ops.test.ts →
"backs up, verifies, and restores with integrity"` failed with
`FAILED: docker cp exited 1`. Cause: **my own concurrent manual `backup.mjs
backup` invocation** during that run — two processes performing `docker cp`
against the same container at once. Not a product defect and not a test defect.
Re-run in isolation after the interference stopped: **8/8 passed**. The final
suite above ran with no other database or Docker activity.

### Not executed in this gate (stated, not hidden)
- Live GLEIF smoke (network opt-in; above).
- End-to-end HTTP smoke against a running production server (`next start -p 3101`
  + manual refresh). Done in an earlier phase; the HTTP surface is covered here
  by direct route-handler tests instead.
- Phase 2 features of any kind.

---

## 9. Change inventory (everything, including non-Discovery working-tree work)

**This patch (F5/F6, F7/F8, F11/F13/F14 + docs):**

| File | Change |
|---|---|
| `lib/discovery/coverage.ts` | Planning atomicity (F5) |
| `lib/discovery/refresh.ts` | Planning-failure finalization (F6), `attributeNewItem` (F13), `unattributedSourceRecords`, F7 counter split, `measures_basis` (F8) |
| `lib/resolve/conflicts.ts` | `conflictAttribution` (F10) |
| `db/tests/t002_verify.sql` | Identity-based seed verification + Discovery structure/privilege/cap checks (F11/F17) |
| `tests/discovery_planning.test.ts` | NEW, 6 tests |
| `tests/discovery_provenance.test.ts` | NEW, 5 tests |
| `tests/discovery_counters.test.ts` | NEW, 4 tests |
| `tests/discovery_routes_security.test.ts` | NEW, 20 tests |
| `tests/identity_conflict.test.ts` | +1 test (attribution) |
| `docs/GRAYSCALES_DISCOVERY_FINAL_VERIFICATION_REPORT.md` | NEW (this file) |
| `docs/GRAYSCALES_DISCOVERY_PHASE2_HANDOFF.md` | NEW |
| `docs/GRAYSCALES_DISCOVERY_FINDINGS_REGISTER.md` | NEW (supersedes the inline list) |
| `docs/GRAYSCALES_DISCOVERY_TEST_TRACEABILITY.md` | NEW |
| `docs/DISCOVERY_OWNER_DECISIONS_O1_O11.md`, `docs/DISCOVERY_BLOCKERS_AND_TRACEABILITY.md`, `docs/GRAYSCALES_DISCOVERY_API_CONTRACTS.md`, `docs/RUNBOOK.md`, `docs/DISCOVERY_READINESS_REPORT_PROMPT5.md` | Updated (registers, contracts, runbook, correction block) |
| `public/creative-login/PROVENANCE.md` | Licensing status (F15) |

**Pre-existing working-tree work that is NOT Discovery functionality** (listed
so the inventory is complete, and deliberately not touched by this gate):
`components/creative-login-form.tsx`, `public/creative-login/*`, `app/login/page.tsx`,
`components/shell.tsx`, `app/globals.css`, `tests/creative_login.test.ts`,
`lib/auth/*` (AUTH-001), `app/api/auth/*`, the intentional deletion of
`app/agencies/loading.tsx`, and the owner's untouched `Creative Login Form/`
folder.

**Not done, by instruction:** Qualification & Prioritization, Opportunity Briefs,
Proposal Preparation, Outreach; no scheduler, no EIP/VaultForge, no external
deployment, no commits, no pushes.