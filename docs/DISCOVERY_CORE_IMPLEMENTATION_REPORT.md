# DISCOVERY CORE IMPLEMENTATION REPORT (Prompt 4)

> Historical record — preserved verbatim below. Prompt 5 delta follows at the end.

> Structural backend increment only. No owner approval was granted since D2,
> so O-gated behaviors refuse or stay structural per the blueprint. Docker was
> unavailable this session, which bounds verification (stated everywhere below).

## 1. Implemented capabilities

- Opportunity keys: deterministic per-pipeline canonicalization, repost
  identity, refusal to invent identity (422, never guessed).
- Opportunities: idempotent registration (UNIQUE arbitrates races),
  allow-list lifecycle transitions with audit, promotion links (once;
  re-promotion returns existing), business relationships with zero merge
  semantics, direct-client rows refused 409 until O1.
- Coverage: plan validation (1..25 tasks), atomic claim (no double-claim),
  finish lifecycle, ledger projection, stop evaluation over EXPLICIT
  thresholds (no defaults exist), shortfall builder that never nets pipelines.
- Eligibility: versioned append-only decisions over explicit caller policy
  (no canonical gate set in code until O10); eligible/ineligible/needs_info;
  history projection; direct-client decisions refused.
- `run.ts` deliberately UNTOUCHED (frozen, tested path).

## 2. File-by-file changes

| File | Change |
|---|---|
| `db/migrations/20261014190001_coverage_tasks.sql` | NEW table `discovery_coverage_task` + indexes + RLS/REVOKE |
| `db/migrations/20261014190002_opportunity_identity.sql` | NEW `opportunity` (per-pipeline unique key, both pipeline values, app-refused direct rows) + `business_relationship` (RESTRICT, no merge) + RLS/REVOKE |
| `db/migrations/20261014190003_eligibility_versions.sql` | NEW `opportunity_eligibility` (insert-only, enforced from M8 = `20261014190008_eligibility_append_only.sql`) + unique (opportunity, version) + RLS/REVOKE |
| `db/migrations/20261014190004_brief_policy_snapshot.sql` | ADDITIVE nullable `brief.policy_version` (pre-snapshot rows read NULL honestly) |
| `lib/discovery/keys.ts` | NEW pure key derivation + fingerprint |
| `lib/discovery/opportunities.ts` | NEW register/transition/linkPromotion + relationship notes |
| `lib/discovery/coverage.ts` | NEW plan/claim/finish/summary/stops/shortfall |
| `lib/discovery/eligibility.ts` | NEW explicit-policy evaluation + history |
| `tests/discovery_keys.test.ts` | NEW 5 unit tests (5 passed, executed) |
| `tests/discovery_opportunities.test.ts` | NEW 8 DB tests (written, UNEXECUTED — no DB) |
| `tests/discovery_coverage.test.ts` | NEW 8 DB tests (written, UNEXECUTED — no DB) |
| `tests/discovery_eligibility.test.ts` | NEW 4 DB tests (written, UNEXECUTED — no DB) |
| `tests/seed.test.ts` | `MIGRATION_COUNT` 26→30 (convention for 4 added migrations, not a weakening) |
| `docs/DISCOVERY_CORE_IMPLEMENTATION_REPORT.md` | This file |

No existing product code modified. No API routes added (deferred to Prompt 5
per minimal-change discipline; contracts doc already specifies them).

## 3. Migration and compatibility results

- NOT APPLIED (Docker unavailable): 4 files hand-reviewed against existing
  migration patterns (CHECK vocabulary, FK actions, partial uniques, RLS +
  REVOKE lines, forward-repair-only rule). Reviewer must apply on scratch
  first: bootstrap → migrate → seed ×2 → verify, then dev+test.
- Compatibility: all additive; nullable or defaulted columns; FKs to stable
  tables with matching actions (RESTRICT on identity/provenance links,
  CASCADE under run/task ownership); no backfill (new tables empty; NULL
  policy_version is the honest pre-snapshot state).
- Rollback/recovery: NO down migrations (runner lacks support by design).
  Forward-repair only. If M2's pipeline CHECK ever needs narrowing, that is a
  NEW migration, never an edit. On apply failure: fix forward, re-run
  `migrate` (idempotent per-file recording).

## 4. Actual tests and results

| Check | Result |
|---|---|
| `tests/discovery_keys.test.ts` (5) | **5 passed, executed** |
| `tests/{normalize,validate,csv}.test.ts` (35, regression probe) | **35 passed, executed** |
| `tests/discovery_{opportunities,coverage,eligibility}.test.ts` (20) | Written, **UNEXECUTED** (need PG; Docker down) |
| Rest of suite | **Not run** (DB-backed; would fail on connection, unrelated to this change) |
| `npx tsc --noEmit` | **Clean, executed** |
| `npm run build` | **Compiled successfully, executed** |
| New migrations applied/verified | **UNVERIFIED** (need PG) |

Self-caught during build: (a) dead `ON CONFLICT DO NOTHING` on audit insert
(removed — audit has no unique target); (b) missing rollback discipline in a
transaction helper (rewritten to explicit rollback); (c) vacuous sync-throw
assertion style in my own keys test (first run passed 4/5 without asserting;
fixed to `toThrow`, now genuinely green).

## 5. Failed, skipped, unverified checks

- Failed: none (no failing check observed; DB checks not attempted).
- Skipped deliberately: full suite, seed/verify, smoke, backup drill (all
  need Docker); new API routes (deferred to Prompt 5).
- Unverified: everything marked UNEXECUTED/UNVERIFIED above + live
  migration apply + RLS denial on new tables (covered by test files once DB returns).

## 6. Known limitations and unresolved decisions

O1–O11 still OPEN (verified unchanged): direct-client paths refuse; no
canonical eligibility content; no planner defaults; no allocation/counting
acceptance; weights untouched. `run.ts` finish counters NOT extended
(deferred: wiring incomplete semantics into the production run path was
judged riskier than leaving the frozen path intact — Prompt 5 composes
counting from the new libs). `linkPromotion` needs a real hypothesis id
(empty-DB path asserts the 404 branch; seeded-DB runs cover the link path).

## 7. Local verification instructions (exact re-run)

1. Start Docker Desktop; `docker compose up -d`; wait `healthy`.
2. `node scripts/db.mjs migrate` (dev+test) → expect 4 applied, no errors.
3. `node scripts/db.mjs seed` ×2 → ok; `verify` → ok.
4. `npx vitest run tests/discovery_keys.test.ts tests/discovery_opportunities.test.ts tests/discovery_coverage.test.ts tests/discovery_eligibility.test.ts` → expect 25 green.
5. `npx vitest run` (full) → expect green incl. updated `MIGRATION_COUNT=30`.
6. `npx tsc --noEmit`, `npm run build`.

## 8. Rollback / recovery procedure

- Code: delete the 4 lib/test files + revert the one-line seed count
  (working tree currently holds them uncommitted — no commit made).
- Migrations (if applied by then): forward-repair only; to vacate dev,
  `db reset`-style rebuild from scratch is the operator's existing nuclear
  option — NOT recommended; prefer keeping additive tables.
- Data: new tables start empty; no existing rows touched by design.

## 9. Remaining scope for Prompt 5

API routes (refreshes/opportunities per contracts doc), UI integration
(runner + collection + shortfall views), `source.enabled` wiring (B-D5),
crashed-run reaping (B-D6), `.env` comment + doc rewordings, full
verification battery, O-gated content behind approvals.

---

# PROMPT 5 DELTA (UI integration + verification status)

> Appended, not rewritten. Prompt 4 body above is the historical record.

## Implemented in Prompt 5

- **API routes (4, per contracts doc):** `POST /api/discovery/refreshes`,
  `GET /api/discovery/refreshes/[id]`, `GET /api/opportunities`,
  `GET /api/opportunities/[key]` — auth + CSRF + attribution + error-shape
  conventions followed exactly. One as-built delta: POST returns
  `{runId, status, tasksPlanned, tasksDone, endState, measures}` (contracts
  doc updated to match; task counts replace the draft counts object).
- **UI:** `/discovery` extended (planner form component
  `components/refresh-plan-form.tsx` + refresh detail from the shared lib
  projection — no duplicated logic); new `/opportunities` (filters,
  offset pagination with totals, never-hidden semantics) +
  `/opportunities/[key]` (identity, evidence with validated external URLs,
  eligibility history, lifecycle); nav `Opportunities (partial)`.
- **Lib:** `lib/discovery/refresh.ts` (orchestration + live summary) +
  `runId` linkage on `registerOpportunity` (additive, backward compatible).
- **Migration M5** (`20261014190005_opportunity_run_link.sql`): nullable
  `opportunity.run_id` FK + index (specified, UNAPPLIED).
- **E2E suite** `tests/discovery_e2e.test.ts` (§4 items 1–17; item 18 by
  milestone3_ops): written, UNEXECUTED (Docker down).
- **Backend review fixes:** prototype-key hardening in coverage tally,
  actor-required guards on all three opportunity writers (offline-tested),
  concurrent double-promotion resolution, eligibility version-race retry,
  redundant index removed, `opportunity_set_updated_at` trigger added to
  unapplied M2 (consistent with repo convention).
- **Docs:** RUNBOOK §5b (manual refresh ops); contracts delta noted above.

### 2026-10-14 — execution happened; three defects found and fixed

Docker Desktop was restarted mid-session, so everything above is now EXECUTED
against a real PostgreSQL (dev + `agency_intel_test`). Migrations M1–M5 applied
on both. Results and the defects they exposed:

1. **`claimTask` ordered by a non-existent column.** `discovery_coverage_task`
   never had `created_at`; every planned refresh failed on its first claim
   (5 test failures). Fixed additively: M6 adds `plan_seq` (plan position —
   required for deterministic FIFO, since one plan's rows share a timestamp and
   `id` is a random uuid) + `created_at`, with `(run_id, plan_seq, created_at,
   id)` index.
2. **`runDiscovery` returned raw pg rows cast to camelCase.** `as
   RunItemResult[]` was a lie: consumers reading `companyId`/`sourceRecordId`
   silently got `undefined`, so the refresh registered ZERO opportunities
   (`if (!item.companyId) continue`). This also made a T-006 conflict test pass
   vacuously (`expect(undefined).not.toBeNull()`). Fixed with an explicit
   mapping; the contract type is now truthful.
3. **Two coverage tests asserted unreachable states** (mid-plan stop rules
   after the task queue was already exhausted, contradicting the blueprint's
   stop precedence). Tests corrected to keep a pending task — assertions were
   strengthened, not weakened.

Two Prompt 4 migrations were edited *before* they were applied (M1
`child_run_id`, M2 `updated_at` trigger); after application neither was touched
again.

## Explicitly NOT done (unchanged from Prompt 4 §9)

`source.enabled` wiring (B-D5), crashed-run reaping (B-D6), `.env`/doc
rewordings, O-gated content, scheduled refresh, or anything in §8's
forbidden list.
