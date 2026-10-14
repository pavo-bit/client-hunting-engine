# R03_SEED_COMPATIBILITY_REPORT - Seed Compatibility and Idempotency Repair

> Date: 2026-10-13. Scope: seed compatibility with the current schema after T-008, deterministic
> demo data, regression coverage. No product features added. T-013 and T-014 NOT started.

## Verdict: PASS

---

## 1. Root cause

`node scripts/db.mjs seed` failed against a fully migrated database:

```
FAILED: new row for relation "hypothesis" violates check constraint "hypothesis_status_check"
```

T-008 replaced the hypothesis lifecycle vocabulary. `db/seed.sql` was written at T-002 and was
never updated, so it carried **two** pieces of pre-T-008 state. Fixing only the reported symptom
would have left the seed broken, so both were found and fixed.

### Defect 1 - obsolete hypothesis status (`db/seed.sql:104`)

```sql
'portals_dashboards', 'evidenced',
```

`hypothesis_status_check` now allows only `generated, needs_review, deferred, rejected,
validated, superseded`. T-008's own migration
`db/migrations/20261013000011_hypothesis_lifecycle.sql:17` performs the remap:

```sql
update public.hypothesis set status = 'needs_review' where status in ('evidenced', 'stale');
```

### Defect 2 - conflict target no longer matches a unique constraint

Masked behind defect 1; surfaced only after that was fixed:

```
FAILED: there is no unique or exclusion constraint matching the ON CONFLICT specification
```

T-008 migration `20261013000012_evidence_polarity_key.sql` changed the
`hypothesis_evidence` primary key from `(hypothesis_id, claim_id)` to
`(hypothesis_id, claim_id, polarity)`, so one claim can appear under both a supporting and a
contradicting heading. The seed's `ON CONFLICT (hypothesis_id, claim_id)` matched no
constraint and aborted the whole batch. Verified directly against the schema: the only
primary key is `hypothesis_evidence_pkey (hypothesis_id, claim_id, polarity)`.

## 2. Canonical status decision

**`needs_review`** - established from the existing domain rules, not invented.

1. **The project's own migration already decided it.** `20261013000011` maps
   `evidenced -> needs_review`. Applying the same mapping to the seed makes a re-seeded
   database identical to a migrated one, so the demo state is self-consistent.
2. **It matches the record's actual evidence.** The seeded hypothesis has three supporting
   claims (d1, d2, d3) *and* one unresolved contradicting claim (d5: "site already links a
   client login page"). In `lib/hypothesis/rules.ts:341` a hypothesis with contradiction
   links is created with status `needs_review`; a hypothesis with evidence and no
   contradiction is `generated`.
3. **`generated` would be wrong** - the record does have evidence, including contradicting
   evidence that must be reviewed.
4. **`validated` would be false.** The record's own rationale says "Human-led validation
   required before validated", and T-011's hard gate `hypothesis-reviewed` would be
   self-contradictory. Claiming validation would also be exactly the kind of unearned
   certainty the project forbids.
5. **`deferred`** would be wrong - nothing in the demo data records a deliberate park.

Because the remap target is literally what the migration already applied to this exact row,
the live dev database (which holds `needs_review`) and a freshly seeded database now agree.

## 3. Files changed and why

| File | Change | Why |
|---|---|---|
| `db/seed.sql` | hypothesis status `'evidenced'` -> `'needs_review'` | Defect 1. Semantically correct, matches T-008's own remap. |
| `db/seed.sql` | `ON CONFLICT (hypothesis_id, claim_id)` -> `ON CONFLICT (hypothesis_id, claim_id, polarity)` | Defect 2. Conflict target must mirror the current primary key. |
| `db/seed.sql` | audit row transition `proposed -> evidenced` -> `generated -> needs_review` | The audit row recorded a transition that no longer exists in the vocabulary. `audit_log.transition_*` is free text, so this was not a failure - it was stale demo data describing a nonexistent transition. |
| `db/seed.sql` | explanatory comments (header, hypothesis, hypothesis_evidence) | Records *why* each value is what it is, so the drift cannot silently recur. |
| `tests/seed.test.ts` | new | Regression coverage (section 5). |

**Not changed:** no migration, no applied-migration timestamp, no `scripts/db.mjs`, no
`lib/`, no `app/`, no `package.json`, no `compose.yaml`, no constraint, no Supabase, no
outreach path, no R-02 assertion change.

## 4. Idempotency and rollback evidence

**Idempotency.** Every INSERT is `ON CONFLICT DO NOTHING` with fixed UUIDs, so re-seeding is
insert-only and never rewrites history. On a freshly migrated scratch database:

| Run | Result |
|---|---|
| seed #1 | `seed ok: db\seed.sql` |
| seed #2 | `seed ok: db\seed.sql` |
| seed #3 | `seed ok: db\seed.sql` |

Row counts after three runs are identical to after one run, in all 16 seed tables:
company 3, discovery_record 4, research_run 2, snapshot 2, claim 5, hypothesis 1,
hypothesis_evidence 4, capability 2, project_option 1, project_capability 1, score_run 1,
brief 1, outreach_draft 1, outcome_log 1, audit_log 2, failure_log 1.

**Rollback.** `scripts/db.mjs` `runFile` sends the whole file as one simple-query batch,
which PostgreSQL wraps in a single implicit transaction, so any error aborts everything.
Evidence, not assumption:

- *Observed before the fix*: the failed seed on a migrated empty database left **all 16 seed
  tables at zero rows** - nothing partial.
- *Asserted by the suite*: a second scratch database is migrated, confirmed empty, then the
  seed batch is executed with a trailing statement that violates
  `claim.info_credibility (1..5)`. It fails with SQLSTATE `23514`, and afterwards every
  table is still empty. A clean seed then succeeds on that database, proving it is usable.

**The seed contains no explicit `BEGIN`/`COMMIT`/`ROLLBACK`.** If it ever did, the atomicity
guarantee above would silently disappear, so a test now asserts the seed does not contain
them.

## 5. Regression coverage

`tests/seed.test.ts` - 10 tests. Isolation: it never touches the development database. It
creates throwaway scratch databases on the same local cluster, drives them through the real
`scripts/db.mjs` runner via `execFileSync`, asserts, and drops them in `afterAll`. Every URL
is asserted loopback before use, and only the two fixed scratch names are ever dropped.

| # | Requirement | Test |
|---|---|---|
| 1 | Seeding succeeds on a fully migrated empty database | `applies every migration to a fresh database` + `seeds successfully and produces exactly the intended demo rows` |
| 2 | Running seed twice duplicates/corrupts nothing | `is idempotent: two further runs duplicate nothing and corrupt nothing` (3 runs, counts compared) |
| 3 | Records and relationships stay consistent | `keeps required relationships consistent after re-seeding` (orphan + cross-company sweep, full company -> hypothesis -> score -> brief -> draft -> outcome chain) |
| 4 | Every seeded hypothesis status is valid under the lifecycle | `keeps every seeded hypothesis status valid under the current lifecycle` (live status in the 6-value set; no legacy value used in the seed, comments stripped; no legacy status in the DB; 3 supports + 1 contradicts preserved) |
| 5 | An induced seed failure rolls back | `rolls back completely when a seed statement fails` |
| 6 | `verify` green after seeding | `leaves \`node scripts/db.mjs verify\` green after seeding` |
| 7 | R-02 source invariant intact | `keeps the R-02 source invariant: 12 categories, connectors counted separately` |

Plus `leaves the development seed data untouched` (dev still holds 3 companies / 5 claims /
1 hypothesis) and `never wraps the seed in an explicit transaction`.

## 6. Exact verification results

| Gate | Command | Result |
|---|---|---|
| Docker/PostgreSQL | `docker inspect grayscales-pg` | `healthy` |
| Migrate (dev) | `node scripts/db.mjs migrate` | `already up to date` |
| Migrate (test) | `node scripts/db.mjs migrate --target test` | `already up to date` |
| Fresh-migrate proof | bootstrap + migrate on scratch DB | `applied 23 migration(s)` |
| Seed on migrated empty DB | `node scripts/db.mjs seed --target test` (scratch) | `seed ok` x3 |
| **Seed x2 (dev)** | `node scripts/db.mjs seed` | `seed ok` x2 (plus 2 more later, all `ok`) |
| **SQL suite** | `node scripts/db.mjs verify` | `verify ok: db\tests\t002_verify.sql` (run 4x during this task, all ok) |
| **Full Vitest** | `npx vitest run` | **17 files, 237 passed, 1 skipped (opt-in), 0 failed** |
| New suite | `npx vitest run tests/seed.test.ts` | **10/10 passed** |
| Type-check | `npx tsc --noEmit` | clean, no output |
| Build | `npm run build` | `Compiled successfully` |

**Dev data intact after seeding twice:** 3 companies, 5 claims, 1 hypothesis
(`needs_review`), 4 hypothesis_evidence rows (3 supports / 1 contradicts), 12 source
categories + 1 connector (`gleif-api`), `score_run` 64/B, brief `BR-2026-001` `in_review`.

**No test residue:** 0 test rows in the test database; the two scratch databases are dropped
by `afterAll`; the temporary `agency_intel_seedtest` database created during investigation
was dropped manually (`pg_database` now lists only `agency_intel` and `agency_intel_test`).

**Defects in my own test code, found and fixed during this task** (recorded because they
were caught by execution): the rollback test initially used a malformed 38-character UUID
(raising `22P02` instead of the intended `23514`); an assertion scanned the seed text for
the word `evidenced` and so failed on the R-03 explanatory comment; a relationship assertion
expected `brief.proposal_id` to be populated, which the seed never sets (see limitation 1).

## 7. Limitations and unresolved items

1. **`brief.proposal_id` is NULL in the seed and was left that way.** The seed predates
   migration `20261013000015_briefs_pipeline.sql`, which added the column. This is not a
   compatibility failure - nothing errors, and `getBriefWorkspace` handles a null proposal.
   It does mean the demo brief is less rich than it could be. Repairing it changes demo
   content rather than compatibility, so it is reported, not silently changed. The
   relationship test now asserts the chain the seed actually declares.
2. **The dev database's existing audit row still reads `proposed -> evidenced`.** The seed
   is insert-only (`ON CONFLICT DO NOTHING`), so the corrected text applies to new seeds
   only. Rewriting that historical row would mean editing audit history, which the project
   forbids. Historical dev rows keep the T-002 wording; that is intentional and correct.
3. **`node scripts/db.mjs verify --target test` still fails with `company count 0, want 3`**
   because the test database is never seeded. This is pre-existing and expected: the file's
   header scopes it to the seeded dev database. Not a regression; not repaired here.
4. **Seed/schema drift can recur.** T-010 through T-013 keep adding columns and constraints.
   The new suite is the guard: any future seed/schema mismatch fails the standard Vitest
   run rather than being discovered by hand.
5. **No seed for a "current" engine-produced demo row.** The seeded hypothesis has
   `rule_id = null` and its `score_run` is `model_version = 'legacy'` (T-011 backfilled
   pre-engine rows). A fully engine-generated demo record would need `rule_id` and a
   `score_v1` row; producing one is a T-013+/T-014 decision about what the demo should
   showcase, not a compatibility repair. Not invented here.
6. **Owner decisions unchanged:** D-004 (catalog content), D-005 (pricing), D-006 (weights,
   needs n >= 30 reviewed outcomes), D-008 (retention windows) all remain OPEN.
