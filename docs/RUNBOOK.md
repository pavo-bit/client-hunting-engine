# RUNBOOK — Local Operation, Triage & Recovery

> Every command below matches the actual repository scripts and was executed
> during Milestone 3. Placeholders are marked `<like-this>`.

## 1. Startup / shutdown

```powershell
# Database
docker compose up -d            # start postgres (loopback-only :5434)
docker inspect grayscales-pg --format '{{.State.Health.Status}}'   # expect: healthy

# App (production build, loopback only)
npm run build
npx next start -p 3101          # serves http://127.0.0.1:3101
```

Shutdown: `Ctrl-C` the app (or stop its process), then `docker compose down`
(stops the container; `pgdata` volume persists — **never** `docker compose
down -v` unless you intend to destroy all data). `restart: unless-stopped`
brings postgres back after host/Docker restarts automatically.

## 2. Migrations & seed

```powershell
node scripts/db.mjs bootstrap [--target test]   # DB + noaccess role (once)
node scripts/db.mjs migrate [--target test]     # ordered *.sql, recorded
node scripts/db.mjs seed                        # dev only; rerun-safe (×N ok)
node scripts/db.mjs verify                      # T-002 assertion suite (dev)
```

Migration count is asserted by `tests/seed.test.ts` (`MIGRATION_COUNT`) —
bump it when adding a migration. Never edit applied migrations; add new ones.

**Pristine end-to-end check (never run destructive checks against dev).**
`verify` needs a migrated AND seeded database. Prove that path on an isolated
scratch database — `db.mjs` loads `.env` only for variables that are unset, so
an explicit `DATABASE_URL` override redirects every command:

```powershell
$env:DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_scratch'
node scripts/db.mjs bootstrap; node scripts/db.mjs migrate
node scripts/db.mjs seed;      node scripts/db.mjs verify
Remove-Item Env:\DATABASE_URL
```

Dev and test databases are untouched by this. The test database is
**migrate-only** (suites build their own fixtures and must not inherit seed
rows), so `verify --target test` is expected to fail and that is not a defect.

## 2b. Phase 2 consumption (explicit operator commands only)

There is no scheduler, watcher or background job for Phase 2 — nothing in the
repository invokes these except an explicit operator command:

```powershell
node scripts/qualify.mjs status --consumer <name> [--target test]
node scripts/qualify.mjs consume --consumer <name> [--batch N] [--target test]
node scripts/qualify.mjs backfill [--pipeline agency_partner] [--target test]
node scripts/qualify.mjs reconcile [--target test]
node scripts/qualify.mjs run-all --consumer <name> [--idempotency-key K] [--target test]
node scripts/qualify.mjs replay --case <case-uuid> [--target test]
node scripts/qualify.mjs assess --opportunity <uuid> [--policy V --catalog V --rubric V --capacity V --as-of ISO --answers JSON --idempotency-key K] [--target test]
```

`assess` resolves omitted versions to the ACTIVE version of each kind and
refuses (never invents) when none is active. Writes require `--actor`
(defaults to your own `OPERATOR_EMAIL`, never a
guess). Read the JSON report before deciding anything: `drifted` means
Discovery moved under a case (investigate, do not re-run blindly);
`orphaned` means the opportunity left the view (the case is kept — you
decide). Contracts: `docs/DISCOVERY_PHASE2_INTERFACE_SPEC.md`,
`docs/PHASE2_EVENT_CONTRACT.md`, `docs/PHASE2_SCHEMA.md`,
`docs/QUALIFICATION_API_CONTRACTS.md`.

## 2c. Qualification review (operator workflow)

- Queue: `/qualification` (filters, pursuit order, suppressed hidden by
  default — append `?suppressed=true` to audit them). Missing scores show
  "—", never zero.
- Case: `/qualification/cases/<case_id>` — identity, dimensions, evidence
  for/against, assessments, rank history, research, decisions, audit. Record
  accept/reject/defer/withdraw there (reasons required; stale assessments
  refuse accept/defer — re-run first).
- Assess: `/qualification/assess` — explicit runs with named versions.
- Research: `/qualification/research` — decision-value ordered questions;
  status moves, due flags and notes per task.
- Policy: `/qualification/policy` — versions, lint/draft/publish/retire,
  capacity profiles. Drafts never affect rankings.
- Metrics: `/qualification/audit` — decisions, gate outcomes, staleness,
  drift, research load, evaluation pointers.
- Today: `/today` — priorities, attention items, health warnings.
- Admin: `/admin` — reconciliation triggers, consumer health, migrations,
  backups. Backup/restore stay terminal commands (see §3).

## 2d. Manual observations (operator workflow)

Record evidence-backed observations about a known agency at `/evidence`
(bottom card) or via `POST /api/evidence/ingest`:

1. Resolve the company first: create it at `/agencies/new` (or
   `POST /api/companies`) when new — duplicate domains/registries are refused
   with 409, never silently merged. Copy its id.
2. On `/evidence`, fill company id, an **enabled** source (only enabled keys
   are offered; disabled sources are refused with 409 before any write),
   the source URL (recorded as provenance, never fetched), a short factual
   excerpt, and a claim (signal family, reliability A–D, credibility 1–5).
3. Optional dates: observed-at (event seen), published-at (source-stated
   publication date — stays empty when the source states none), expires-at.
4. Submit: identical resubmissions collapse onto the existing snapshot
   (`existed: true`, no new rows). Validation errors arrive as
   `{code, message}` — no stacks, no secrets.
5. Privacy: personal emails (`firstname.lastname@…`) and personal social
   profiles (`linkedin.com/in/…`) are refused by validation; use public
   business channels (`info@`, `contact@`, …). The check blocks recognizable
   shapes only — review pasted text before submitting.

Signal families (closed vocabulary): identity, provides_service, operates_in,
announced, hiring, contact, partnership, growth, service_request, other.

## 2e. Greenhouse hiring signals (IMPLEMENTED — CURRENTLY BLOCKED, DO NOT ENABLE)

The Greenhouse Job Board adapter exists, is tested, and is registered
passively, but the source key `greenhouse-job-board` ships **disabled**. Do
not enable it until the licensing decision in
`docs/P2_SOURCE_SELECTION.md` §5 is recorded and dated by the owner. The API
is free and keyless; what is unverified is the right to retain employer job
data for commercial analysis. Until then, use §2d (manual observation), which
needs no licence.

For the record, once (and only once) that decision is recorded:

1. **Link the board token to a company.** The API exposes no company domain
   or registry id, so identity is operator-declared and nothing is inferred:

   ```sql
   insert into public.discovery_record
     (company_id, source_key, source_record_id, collection_method,
      retrieval_status, query_text, note)
   values ('<company-uuid>', 'greenhouse-job-board', '<board-token>',
           'manual', 'ok', '<board-token>', 'operator-declared board-token link');
   ```

   The board token is the path segment of the employer's careers page:
   `https://job-boards.greenhouse.io/<board-token>/jobs` → `<board-token>`.
   Re-linking a token to a different company is refused (409); resolve
   identity manually instead.

2. **Enable the source** (`update public.source set enabled = true where key
   = 'greenhouse-job-board'`) — only after step 0.

3. **Run one board:** call `runSignalSource(pool, getProductionRegistry(),
   { adapterId: 'greenhouse-job-board', queryText: '<board-token>', actor,
   limit, maxPages })`. It is a one-shot operator action; there is no
   scheduler and no background worker.

Expected outcomes: an unlinked token returns `unresolved` and writes nothing;
a disabled source returns `source_disabled` before any write; a repeat run
reports `duplicates` and writes nothing; a posting the employer has since
edited is reported as `amended` and appended to the evidence ledger (the
ledger is append-only — the prior observation is never silently rewritten).

Postings become `hiring` claims with reliability `B` / credibility `2`,
`published_at` from the source's `first_published` and `observed_at` from its
`updated_at` — both left NULL when the source states neither. A posting is
evidence of an open requisition only, never of intent to subcontract.

## 2f. Directory, filters and export

- `/agencies` — server-side search (`q` matches id, name, domain, country,
  registry id; `%` and `_` are literals), plus `country`, `agencyType`,
  `status`, `perPage`, `sort` and `dir`. Pagination is real: the count in the
  heading is the SQL count, not the length of a fetched page. Sort keys are a
  closed allowlist; anything else falls back to `created_at`.
- **Workflow state vs verdict.** `candidate / resolved / qualified / rejected /
  archived` on a company is lifecycle. A qualification verdict lives on a
  qualification case (`/qualification/cases/<id>`). Do not read the company
  badge as a verdict.
- **Evidence columns.** `evidence_count` is the number of distinct observation
  snapshots; `latest_source_key` / `latest_evidence_at` attribute the newest
  one. A company showing `none` has **no provenance** — that is missing
  information, not a clean record.
- **Export** — `GET /api/export` with the same query parameters as the page
  plus `format=csv|json`. Requires an operator session (401 otherwise). The
  export is built from the same SQL builder as the screen, so it cannot drift
  from what you were looking at.
  - Columns are stable and documented in `lib/export/csv.ts`; their meaning
    travels with the JSON export (`columns[].semantics`).
  - `discovery_status` in an export is explicitly a WORKFLOW state, not a
    qualification verdict.
  - CSV is RFC 4180 with CRLF and a UTF-8 BOM. Fields containing quotes,
    commas or newlines are quoted and inner quotes doubled.
  - **Cells beginning `=`, `+`, `-`, `@`, TAB or CR are prefixed with `'`** so a
    spreadsheet treats them as text instead of executing them. That applies to
    every column, because company names and pasted claim text are untrusted.
  - Exports contain company fields and evidence attribution only — no claim
    text, no raw payloads, no credentials, no personal contacts.
  - Capped at 500 rows. When the cap trims the result the response sets
    `X-Export-Capped: true` and JSON returns `truncated: true`. Narrow the
    filters; the truncation is never silent.

## 2g. Pilot report (measurement, not projection)

`/pilot` reports observed counts over the current database. Read it with the
caveats it prints:

- Every metric shows its own denominator and an explicit caveat. A share is
  printed only when the denominator is non-zero.
- **Precision is withheld below 30 reviewed labels** and reported as
  "not reported" rather than as 0% or 100%. With no reviewed labels it is
  `null` by design — signal counts are not a proxy for quality.
- "Candidates approved for review" is **structurally zero while no active
  policy exists**, because assessment is refused with `409
  no_active_reference`. That is a blocked workflow, not a measured outcome, and
  the page labels it as such.
- A disabled source is refused *before* a run row exists, so "no runs" is never
  evidence of failure.
- If the page says INCONCLUSIVE, it is because the sample is too small to mean
  anything yet. Do not work around it by generating records.

## 3. Backups & recovery

Full procedure: `docs/DATABASE_BACKUP_RESTORE.md`. Short version:

```powershell
node scripts/backup.mjs backup
node scripts/backup.mjs verify backups\<file>.dump
node scripts/backup.mjs restore backups\<file>.dump --scratch <new-db> [--keep]
```

Restore never touches `agency_intel` / `agency_intel_test` (refused by name).
Measured local restore: ~3 s at ~10 MB. No off-host copies exist.

## 4. Credentials (provision / rotate / recover)

```powershell
node scripts/operator.mjs init     # prints OPERATOR_EMAIL + OPERATOR_PASSWORD_HASH
node scripts/operator.mjs check .env
```

- Paste the printed lines **exactly** (`$` → `\$` escaping is required —
  Next.js expands `$VAR` in `.env`; `check` catches unescaped values).
- **Rotate:** run `init`, replace both lines, restart the app. Every login
  revokes prior sessions, so rotation takes effect on next sign-in; to force
  it immediately, log in once yourself.
- **Recover (locked out):** re-provision via `init` (needs host access —
  there is no remote reset path by design), restart, sign in.
- **Invalidate all sessions:** sign in (revokes priors) or
  `revokeAllSessions` via SQL as owner.
- Dev `.env` holds a documented placeholder credential — production MUST run
  `init`; the server refuses production boot otherwise (`auth_not_configured`).

### 4b. The sign-in page (`/login`)

- `/login` is a **standalone page**, not a dashboard screen: no sidebar, no
  search bar, no section footer — only the security notice and the form. Every
  unauthenticated request is redirected there, and the dashboard (sidebar,
  search, pages) appears only **after** the server accepts the credential.
- The page renders the owner's creative form (artwork from
  `public/creative-login/`, animated by the pinned `gsap` dependency — no remote
  script, so it works offline). The whole scene renders **50% larger** than a
  plain fit-to-window, and the form's letter size is deliberately held constant
  (the artwork, cords and input boxes grow; the words stay 15 px).
- **Typing a valid e-mail starts the submit animation**: the gear train spins,
  the sprayer runs and the submit cord-button swings into place. Tick the consent
  box to pull the cord, then press submit (Enter always works). The demo's own
  file was not modified — `public/creative-login/activate-on-email.js` (ours)
  drives the same timelines from the e-mail field; see PROVENANCE.md there.
- **To use a different credential**, change it with `scripts/operator.mjs`
  (above). Never write a password into a page or component: it would ship to
  the browser and be readable by anyone with devtools. `tests/creative_login.test.ts`
  fails the build if one appears.
- Failed sign-ins always show the same generic message and clear the password
  field; the server never reveals whether an account exists.
- The form never decides authentication — the server checks the scrypt hash,
  applies the login rate limit, and sets the session cookie.
- Expected behaviour to verify after any change: `curl -o /dev/null -w '%{http_code}'`
  must return **307** for `/`, `/agencies`, `/discovery`, `/opportunities`,
  `/review`, `/resolve` when signed out, and **200** for `/login` only. A 200
  on a gated page means something is streaming a shell before the auth check —
  see the `loading.tsx` note below.

## 5. Health checks & log inspection

- `GET /api/health` → `{"status":"ok","db":{"ok":true,"latencyMs":N}}`
  (200) or `{"status":"unhealthy",…}` (503). Public by design; carries no
  private data. Poll it after every start/restart.
- Every request logs one JSON line (`event=request`, reqId/method/path) and
  every auth decision logs one more (`event=auth|login`, outcome only —
  never identities, passwords, tokens, or bodies). See stdout of
  `npx next start` (or `docker logs` if containerized later).
- Boot prints one JSON line (`event=boot`, env/auth-configured/dev-open flags,
  db host — no secrets).
- Triage order: health → boot line → request lines around the failure →
  `failure_log`/`audit_log` via `/audit` → reproduce with the domain's own
  test suite before changing code.

## 5b. Manual refresh (Discovery)

- Plan on `/discovery` (planner form, 1..25 queries) or
  `POST /api/discovery/refreshes`; runs execute synchronously, then report.
  No scheduling exists — every refresh is an explicit operator action.
- Read status: `/discovery?refresh=<runId>` or
  `GET /api/discovery/refreshes/<id>` (coverage ledger, six measures,
  end-state, shortfall rows). Task yields are frozen history; opportunity
  states reflect now (re-evaluation moves rows by design).
- Shortfalls are explicit rows (never transferred between pipelines);
  caller-stated targets only — no approved allocation exists (O2).
- Identity ambiguity → `/resolve` review queue (never auto-merged).
- Failed run recovery: inspect the task ledger + child runs, fix the cause
  (terms, network, bad query), re-run the plan — reruns are idempotent
  (uniques arbitrate; history appends, entities don't duplicate).
- **Crashed/stalled runs** (process died mid-run): `/discovery` shows a
  warning while any run is still `running`, and the recovery card closes them
  out — or `POST /api/discovery/reap {staleAfterMinutes, dryRun?}`. State the
  threshold yourself; there is no default and no scheduler. Dry run first:
  it lists candidates and writes nothing. Reaping moves the run to `failed`
  with a reason, fails its unfinished tasks, and writes one audit row + one
  `failure_log` row per run. Nothing is deleted and nothing resumes
  automatically; re-run the plan afterwards. Caveat: there is no heartbeat,
  so a threshold shorter than a genuinely slow run will close a healthy run —
  that judgement is yours, which is why dry-run exists.
- **Reaping a run that is still executing**: the reap wins and nothing is lost
  or duplicated. The in-flight task keeps the reaper's `failed` state (a late
  worker is refused, 409 — it never rewrites a closed task), the run's
  `finished_at` and reason are not touched a second time, one audit row + one
  `failure_log` row exist per reaped run however many times you reap, and the
  work the child run already committed (companies, opportunities, yields)
  stays. The worker then finalizes nothing and its response reports the status
  actually stored on the run, not its own local tally.
- **Source permission** is a hard gate: an adapter runs only while its
  `public.source.enabled` row is enabled. A disabled/unknown source refuses
  the run *before* any row is written (409 `source_disabled`, 422
  `unknown_source`) — fix terms/permissions, do not edit run rows by hand.
  Current permissions are listed on `/discovery` under Source permissions.

## 5c. Identity conflicts (human work, never automatic)

- When a discovered record collides with an existing canonical agency (same
  registry id in the same country, or the same domain), the record is REFUSED
  from becoming a company — canonical identity rules (D-011) hold. The run
  counts a `conflict` and captures an **identity conflict** row: what the source
  claimed, against which existing agency, under which rule, with the source
  record id. Nothing is merged, nothing is overwritten, and no second company
  row is created.
- Read them on `/discovery` → open the run → "Identity conflicts" (also in
  `GET /api/discovery/runs/<id>`), and unresolved ones stay OPEN forever until
  a human decides. Re-running a discovery does not duplicate captures.
- Decide them yourself: `lib/resolve/conflicts.ts`
  (`decideIdentityConflict`) records `reviewed`/`deferred` with actor + reason
  and writes an audit row. Deciding a conflict never merges companies — the
  actual identity outcome is made in the existing resolution workflow
  (`/resolve`), by a human, with its own audit trail.
- Absence of evidence is not evidence of absence: a conflict row says "the
  source claimed X", never "X is the same company as Y".

## 5d. Distinct counters (do not mix them up)

| Counter | Meaning | Source |
|---|---|---|
| `found` / `new` / `duplicates` / `skipped` / `conflicts` / `failed` | per-run record outcomes, frozen at run end | `discovery_run` |
| task ledger (`done`, `failed`, `skipped_low_yield`, yields) | per-coverage-task outcome of a refresh, frozen | `discovery_coverage_task` |
| `new_eligible`, `promoted`, `excluded`, `stale`, `unresolved` | refresh-level opportunity states, LIVE (re-evaluation moves rows) | `opportunity.status` |
| `unresolved_opportunities` / `unresolved_tasks` | the two things `unresolved` adds together: businesses awaiting a human decision, versus plan work not yet finished | `opportunity.status` / `discovery_coverage_task.status` |
| `measures_basis: "live_projection"` | reminder carried in every summary payload that the measures above are read-time projections, not a frozen record of the run | — |
| `unattributedSourceRecords` | new records found but NOT registered because their stored source key could not be resolved — nothing is invented (non-zero means investigate provenance, not the data) | `discovery_record.source_key` |
| `new_evidence` | distinct claims created for this refresh's companies during the run window | `claim` |
| `duplicates` (refresh level) | duplicate run items across the refresh's child runs | `discovery_run_item` via `child_run_id` |
| child run `partial` | the page budget (≤3 pages) ran out with more pages available — not a failure | `discovery_run.status` |
| `conflicts` (run level) | records refused by canonical identity rules; captured for review, never merged | `discovery_run.conflicts` + `identity_conflict` |
| shortfall | target minus actual, per pipeline, never transferred | computed |
| opportunity total on `/opportunities` | every stored opportunity in that pipeline, all statuses | `opportunity` |

`eligible` on an opportunity is a lifecycle status, not a purchased-intent
signal. Counting content itself (which records count as eligible new) is
owner decision O3/O10 and stays unimplemented on purpose.

## 6. Incident triage (symptom → action)

| Symptom | Likely cause | Action |
|---|---|---|
| `/api/health` 503, `db.ok:false` | Postgres down | `docker start grayscales-pg`, wait `healthy`, re-check; counts must be unchanged |
| Pages show "Local database unreachable" | Same as above | Same as above (pages degrade to error states, no stacks) |
| Login 503 `auth_unavailable` | `.env` credential missing/mangled | `operator.mjs check .env`; re-provision; restart |
| Login 429 `rate_limited` | 5 bad attempts / 10 min | Wait, or restart app (ledger is in-memory by design) |
| Login 401 with correct password | Unescaped `$` in hash (mangled by Next expansion) | Re-paste from `operator.mjs hash`, exact bytes; `check` must say present |
| `verify` fails `source count` | Stale assertion (fixed R-02) — should not recur | Inspect, don't weaken; see R-02 report |
| `verify` fails `company count` | Fixed 2026-10-15 (F17): verification is now identity-based, so a dev database holding real discovered companies passes. If it fails now, a **seed row** is genuinely missing or altered — investigate, do not delete discovered data | Check the named seed uuid/domain; never satisfy a count by deleting opportunities |
| `verify` fails a Discovery structure block | A migration dropped/changed a table, constraint, index or guard trigger | Compare with `db/migrations/2026101419000{1..8}_*.sql`; add a forward migration, never edit an applied one |
| `seed` fails mid-run | Whole batch rolled back (atomic) — nothing partial | Fix the cause, re-run; see R-03 report |
| Port 3101/5434 in use | Stale process | Find listener, stop it, restart |

## 7. Known recovery limitations

- No off-host backups; no schedule yet (manual). RPO/RTO are proposals —
  `docs/DATABASE_BACKUP_RESTORE.md` §4/§6.
- No metrics pipeline: error rates/latency are manual log inspection.
- Rate-limit ledger is in-memory (restart clears it).
- Disk-exhaustion behavior is untested (unsafe to test on this host).
