# R02_SOURCE_CATEGORY_VERIFICATION_REPORT - Source Category Verification Correction

> Date: 2026-10-13. Scope: correct the documented verification mismatch in
> `db/tests/t002_verify.sql` only. No migration, seed, application or workflow behaviour was
> changed. T-013 was NOT started.

## Verdict: PASS

---

## 1. The mismatch

`node scripts/db.mjs verify` failed with:

```
FAILED: source count 13, want 12
```

`db/tests/t002_verify.sql:15-16` (before) counted every row in `public.source`:

```sql
select count(*) into n_source from public.source;
if n_source <> 12 then raise exception 'source count %, want 12', n_source; end if;
```

## 2. Inspection: what the invariant actually is

| Evidence | Finding |
|---|---|
| `db/migrations/20261012000002_company_source.sql:60-72, 97` | The table is created as "exactly the 12 approved categories (S-01..S-12)" with a `category` CHECK limited to S-01..S-12, then seeded with 12 rows. |
| `db/migrations/20261013000006_discovery_runs.sql:57-60` | T-006 inserts an **additional** row, `('gleif-api','S-02','GLEIF LEI Index (api.gleif.org)','A',true)`, "in the policy registry" - a live source under the existing S-02 category. |
| `db/migrations/20261013000007_source_kinds.sql:1-11` | Adds `kind text not null default 'category' check (kind in ('category','connector'))` and backfills `gleif-api` to `kind='connector'`. Its comment states the intent verbatim: "The 12 approved categories (S-01..S-12) are LOCKED policy rows; live connectors (e.g. gleif-api) are instance rows under a category. This keeps the 12-category invariant exact while allowing audited live sources." |
| `docs/T006_DISCOVERY_SOURCE_REPORT.md:19, 46` | Lists the `gleif-api` source row as a T-006 migration and records "12-category invariant (source kinds migration)" as a mid-task fix. |

**Conclusion: confirmed.** The invariant is exactly **12 rows where `kind = 'category'`**.
Connector rows are additional source records, not a violation of it. The old assertion
conflated two different things and was itself the defect. The live database was correct all
along; the gate was wrong.

## 3. The correction (`db/tests/t002_verify.sql` only)

**Block 1** - the count now filters to categories, with a message that names what it measured:

```sql
select count(*) filter (where kind = 'category') into n_source_category
  from public.source;
if n_source_category <> 12 then
  raise exception 'source CATEGORY count %, want 12', n_source_category;
end if;

select count(*) filter (where kind = 'connector') into n_source_connector
  from public.source;
```

The connector count is still read and emitted via `raise notice`, so it is never ignored.

**Block 1b (new) - source registry invariants.** Proves all three required properties
against the live registry:

- (a) exactly 12 category rows;
- (b) every category row maps to one of the 12 approved S-codes;
- (c) every connector row hangs off an approved category (no orphan code);
- (d) the T-006 `gleif-api` connector is still present, `kind='connector'`, `category='S-02'`, `enabled=true`;
- (e) inserting an **additional** connector leaves the category count unchanged, is counted as a source row, is not hidden, and the registry is returned to exactly its prior state.

**Evidence output** - connector rows are made more visible, not less. The counts row now
reports `source_categories`, `source_connectors` and `source_rows_total` separately, and a
new `select key, category, kind, enabled, reliability_prior from public.source order by
kind, key` dumps the full registry.

**Preserved:** every other assertion in the file is untouched - seed counts for companies
and claims, `hypothesis_evidence` 3/1, the score row 64/B, the provenance chain, the
no-delivery-path schema scan, all negative tests (duplicate `domain_norm`, invalid claim
status, out-of-range source category, snapshot immutability, snapshot delete, audit
immutability), the cross-company trigger test, and both `noaccess` RLS/REVOKE denial checks.
No assertion was weakened, skipped or removed.

## 4. New Vitest regression suite

`tests/source_registry.test.ts` (5 tests) enforces the same rules in the standard
regression run, which `db.mjs verify` alone does not cover. It asserts the 12 seeded
category **keys** and the full set of 12 S-codes, the presence/type/enabled state of
`gleif-api`, `total == categories + connectors` (nothing hidden), the
connector-does-not-change-category-count property inside a transaction that is always
rolled back, rejection of a connector with an unapproved `S-13` code (SQLSTATE 23514), and
zero probe residue.

## 5. Actual execution evidence

**Negative control - the guards have teeth.** A 13th category row
(`r02-negative-control`, kind `category`) was deliberately inserted, then removed:

- `node scripts/db.mjs verify` -> `FAILED: source CATEGORY count 13, want 12`
- `npx vitest run tests/source_registry.test.ts` -> `2 failed | 3 passed (5)`

Both guards detect a genuine break of the invariant.

**Defect found in my own new check, caught by itself.** The first run of block 1b failed
with `probe connector was not counted as a source row (1 -> 14)`: the baseline
`n_before` was initialised from the *connector* count while the post-insert `n_after` used
*total rows*. The baseline was corrected to `count(*)` before proceeding. Recorded because
it is the only correction made to my own work, and it was caught by execution, not review.

**After correction:**

| Gate | Command | Result |
|---|---|---|
| SQL suite (dev) | `node scripts/db.mjs verify` | `verify ok: db\tests\t002_verify.sql` (run 3x: after correction, after the negative control, and as the final run) |
| Full Vitest | `npx vitest run` | **16 files, 227 passed, 1 skipped (opt-in), 0 failed** |
| New suite | `npx vitest run tests/source_registry.test.ts` | **5/5 passed** |
| Type-check | `npx tsc --noEmit` | clean, no output |
| Build | `npm run build` | `Compiled successfully` |
| Migrations | `node scripts/db.mjs migrate` (dev + test) | `already up to date`; 23 applied, latest `20261013000018_scoring_runs.sql` |
| Container | `docker inspect grayscales-pg` | `healthy` |

**Suite evidence rows (dev database, captured by executing the same file):**

```
check, companies, source_categories, source_connectors, source_rows_total, claims
counts, 3, 12, 1, 13, 5

key, category, kind, enabled, reliability_prior
agency-directory   S-05  category   true   B
biz-directory      S-03  category   false  C
company-site       S-08  category   true   B
dev-ecosystem      S-06  category   false  B
facebook           S-12  category   false  D
hiring-platform    S-07  category   false  C
instagram          S-11  category   false  D
launch-platform    S-04  category   false  C
linkedin           S-09  category   false  C
registry-generic   S-02  category   false  A
search-web         S-01  category   false  C
x-platform         S-10  category   false  D
gleif-api          S-02  connector  true   A
```

12 categories, 1 connector, 13 rows total, `gleif-api` present and visible.

## 6. Blast-radius check

**Changed in this task (only these):**

- `db/tests/t002_verify.sql` - the category-count assertion, the new block 1b, and the evidence output.
- `tests/source_registry.test.ts` - new.
- `docs/R02_SOURCE_CATEGORY_VERIFICATION_REPORT.md` - this report (new).
- `docs/DECISIONS_AND_OPEN_QUESTIONS.md`, `docs/DATA_MODEL_AND_EVIDENCE.md`, `docs/T012_REVIEW_QUEUE_REPORT.md` - R-02 entries corrected from "open" to "resolved", so no document still claims a red gate.

**Not changed:** no migration (all 23 retain their original timestamps; newest is
`20261013000018_scoring_runs.sql` at 15:15, before this task began), no `db/seed.sql`, no
`lib/`, no `app/`, no `scripts/db.mjs`, no `package.json`, no `compose.yaml`, no Supabase
dependency, no outreach path. `vitest.config.ts` still carries the T-012 change only.

**Seed intact:** companies 3, claims 5, source categories 12, source connectors 1,
`gleif-api` enabled, score row 64/B, brief `BR-2026-001`. No probe rows survive in either
database.

## 7. Discovered but NOT fixed (out of scope, pre-existing)

> Historical note: the seed defect below was repaired the same day under R-03. The wording
> is preserved because it records what was true when R-02 was verified.

`node scripts/db.mjs seed` **fails** against a migrated database:

```
FAILED: new row for relation "hypothesis" violates check constraint "hypothesis_status_check"
```

`db/seed.sql:104` inserts hypothesis status `'evidenced'`. T-008 replaced the enum; the
current `hypothesis_status_check` allows only `generated, needs_review, deferred, rejected,
validated, superseded`. The live seeded row is `needs_review`, so the earlier T-002/T-003
era report that the seed is idempotent no longer holds after T-008.

This is unrelated to R-02 and was deliberately **not** fixed: the task requires that no
unrelated file or migration change, and repairing the seed is a separate decision (it should
also decide what the canonical demo hypothesis status should be). The failure is atomic -
`client.query()` sends the seed as a single simple-query batch in one implicit transaction -
and this was confirmed empirically: immediately after the failed run the counts were still
3 companies / 5 claims / 12 categories / 1 connector and `verify` passed. Nothing was
corrupted. It should be tracked as its own task before T-014 ("20-brief validation + MVP
sign-off"), which depends on a working seed.

Also noted, and expected: `node scripts/db.mjs verify --target test` fails with
`company count 0, want 3` because the test database is never seeded. The file's own header
scopes it to the seeded dev database ("Run against a FRESH LOCAL database after
`node scripts/db.mjs migrate + seed` (target dev)"). Not a regression, and not a required
gate; the test-target equivalent of this correction is `tests/source_registry.test.ts`.

**Update 2026-10-13 (R-03):** the `db/seed.sql` failure recorded above as "discovered, not
fixed" has since been repaired - see `docs/R03_SEED_COMPATIBILITY_REPORT.md`. The text in
this section is left as originally recorded, since it describes the state at the time R-02
was verified. The `verify --target test` note above still stands.

## 8. Status of open items

- **R-02: RESOLVED.**
- D-004 (capability catalog content), D-005 (pricing), D-006 (scoring weights, needs
  n >= 30 reviewed outcomes), D-008 (retention windows): still OPEN, unchanged, not
  resolvable by implementation work.
- New: seed-replay defect (section 7) - OPEN, not started.
- **T-013: not started**, as instructed.
