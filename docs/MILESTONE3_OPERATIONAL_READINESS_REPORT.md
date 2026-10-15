# MILESTONE 3 — Operational Reliability & Release Engineering (working report)

> Status: IN PROGRESS (baseline complete, implementation underway).
> AUTH-001, R-02, R-03 guarantees are preserved throughout. No Milestone 4,
> no public deploy, no cloud, no architecture redesign.

## 1. Baseline (inspected before any change)

| Area | Exists | Missing / gap |
|---|---|---|
| Compose | `postgres:17.11`, loopback-only port 5434, `pgdata` volume, pg_isready healthcheck, `restart: "no"` | Restart policy review (explicit §4 item) |
| Database | 26 migrations + runner, seed + verify, RLS/noaccess, 28 tables / 78 indexes, dev DB ~10 MB | Backup/restore workflow, RPO/RTO |
| Backups | One legacy artifact: `backups/pre-migration-20261013.dump` (492 KB, custom-format `PGDMP`, D-012 era — preserved, never deleted) | Repeatable backup + isolated-restore procedure, integrity verification, retention/encryption policy |
| Auth/ops | Sessions + provisioning + boot gate (`assertAuthAvailable`), audit_log, failure_log | Health endpoint, request IDs, server log redaction audit |
| Logging | No server-side logging at all (zero secret-leak surface, zero observability); one client-side `console.error` in `app/error.tsx` (browser console, Next-sanitized errors) | Structured logs, latency/error-rate visibility |
| CI | None (no `.github/`, no git repo at all) | Minimal CI definition + local validation of every step |
| Deps | `package-lock.json` present; vitest 3.0.5, next 15.5.27 | Audit findings below |
| Perf | No measurements exist | Benchmarks at seed scale; 50-project-record scale preserved (frozen) |

**Dependency audit (executed `npm audit`, npm registry metadata):**

| Finding | Severity | Decision |
|---|---|---|
| vitest chain (tinypool RCE gadget, mocker path traversal, UI file read) — dev-only | 2 critical + 1 moderate | **Currency upgrade + accepted risk, documented**: installed vitest 3.0.5 → 3.2.7 (same major; suite re-run proves compatibility), but registry metadata confirms the advisories are fixed only in vitest 5.x (breaking major) — the upgrade itself resolves nothing audit-tracked. Exploitability here ≈ nil: vitest never ships in the served app, tests are first-party code, the Vitest UI server is never run. Revisit on a vitest-5 migration, not here. |
| next → postcss ≤8.5.22 (CSS-toolchain XSS / sourceMappingURL file read) | 1 high + 1 moderate | **Accepted risk, documented**: fix requires Next 16 (breaking major, redesign-scale churn); exploitable only via attacker-controlled CSS at build time; all CSS here is developer-authored and the tool is local-only. Revisit on the Next 16 migration, not here. |

Suite baseline at start: **21 files / 286 passed / 1 skipped** (from Milestone 2 close).

## 2. Agreed scope (from the mission brief)

| # | Work | Basis |
|---|---|---|
| S-1 | Backup/restore workflow + integrity verification | §2 |
| S-2 | Health endpoint + request-ID logging + boot validation | §3 |
| S-3 | Restart policy + env-validation wiring | §4 |
| S-4 | Dependency audit (upgrade only with evidence) | §4 |
| S-5 | Minimal CI definition + local validation of every step | §5 |
| S-6 | Failure drills (real where safe; disk-exhaustion excluded) | §6 |
| S-7 | Measured benchmarks at seed + 50-project-record scale; optimize only with evidence | §7 |
| S-8 | Runbook + backup/restore doc + release checklist + this report | §8 |

Out of scope (unchanged): public deploy, cloud, architecture redesign,
weight/catalog/pricing/retention decisions, T-014 labor, automated outreach.

## 3. Implementation results

### S-1 — Backup & restore (`scripts/backup.mjs`, new)

Version-matched `pg_dump -Fc` via `docker exec` (no host tools, no skew);
manifest sidecars (timestamp/db/format/bytes/sha256/pg-version, **no
secrets**); password via transient exec env only, never printed/logged.
`verify` recomputes sha256 + parses the TOC. `restore` targets **fresh,
non-protected** scratch databases only (dev/test names refused; existing
names refused), runs integrity checks (migrations, counts, **12 source
categories**, zero orphan claims), drops the scratch DB afterwards unless
`--keep`, and **drops it again on pg_restore failure** (no partial restore
left behind — added after a drill exposed the litter).
Evidence: dev dump 114,902 bytes / 214 TOC entries; restore+checks **~2.5 s**;
invalid artifact → clean `not a valid archive` failure; protected/existing
names refused. Legacy `pre-migration-20261013.dump` preserved untouched.

### S-2 — Observability (all new, all proportionate)

- `GET /api/health` (public by design, minimal `{status, db:{ok,latencyMs}}`
  — shape-asserted private-field-free): 200 healthy / 503 during outage.
- `middleware.ts`: `x-request-id` assign + propagate + one JSON line per
  request (method + path only — redaction by construction, statically
  tested). It cannot see response statuses (Edge limitation, documented);
  status-accurate logging therefore lives at the decisions:
  `lib/ops/http-log.ts` logs every auth denial and login outcome with a
  fixed narrow shape (redaction unit-tested).
- `instrumentation.ts`: production boot fails closed without secrets
  (`auth_not_configured`) and prints a secret-free boot line (smoke-verified).

### S-3/S-4 — Hardening

- Compose `restart: "no"` → `"unless-stopped"` (safe SIGTERM shutdown
  verified in logs; healthcheck unchanged; loopback binding unchanged;
  container recreated + healthy).
- `assertAuthAvailable` was test-only — now wired to real boot (gap closed).
- Deps: vitest 3.0.5 → 3.2.7 (suite proves compatibility); vitest-criticals
  + next/postcss recorded as accepted dev/build-time risks (fixes need
  breaking majors; exploitability ≈ nil here).

### S-5 — CI (`.github/workflows/quality-gates.yml`, new)

Minimal gates: lockfile install → tsc → bootstrap → migrate → seed ×2 →
verify → vitest → build, against a job-created scratch DB on loopback-only
postgres:17. No git remote exists, so provider execution is **unvalidated by
necessity** — stated in the file. Instead every step was executed locally in
order (see §4), which caught **13 real failures** from running the suite on a
SEEDED database (absolute-count assertions in sales/outcomes/search/ops
tests + a capability-key collision with the seed). All fixed by scoping
assertions to fixtures and namespacing test keys — zero assertions weakened —
and the full suite now passes on BOTH empty and seeded databases. Two review
findings also corrected the workflow itself before first use (missing
bootstrap step; wrong `$`-escaping advice for Actions env).

### S-6 — Failure drills (all executed, none mocked)

| Drill | Isolation | Expected | Actual | Result |
|---|---|---|---|---|
| PG down during request | `docker stop` (dev DB, counts recorded before) | health 503, pages error-state, API 401-before-DB, no stacks | health 503 `db.ok:false`; `/api/companies` 401 JSON; `/login` 200 form; no stack traces anywhere | PASS |
| Restart + recovery | `docker start`, wait healthy | clean shutdown log, counts identical, verify green | fast-shutdown checkpoint, no crash recovery, 3/5/1/72 identical, verify ok | PASS |
| Invalid backup verify/restore | garbage file, scratch names | clean failures, nothing left behind | TOC + pg_restore errors; failed restore self-drops scratch | PASS |
| Protected/existing restore targets | dev name + existing scratch | refusals | both refused verbatim | PASS |
| Expired/revoked sessions | in-process (auth suite) | 401s | 401s + revocation marks | PASS (16 tests) |
| Concurrent conflicting updates | in-process (existing suites) | one winner, 409s | unchanged, green | PASS |
| Idempotent ops | in-process (seed ×3, import) | identical counts | identical | PASS |
| Invalid prod config | in-process + boot | throw / 503 | `auth_not_configured` + 503 | PASS |
| App shutdown/restart | stop/start `next start` | healthy again | healthy, boot line re-printed | PASS |
| Disk exhaustion | — | — | **SKIPPED as unsafe** on this host (documented, not simulated) | N/A |

### S-7 — Performance (measured 2026-10-13, scratch DB, 50 generated companies)

| Operation | Result (local Docker PG, 10 MB scale) |
|---|---|
| Setup 50 companies | 881 ms total (~18 ms/row) |
| `globalSearch` | med ~54 ms (30 runs) |
| `getReviewQueue` | med ~51 ms |
| `generateHypotheses` (cold) | ~11 ms |
| `evaluateHypothesis` | ~67 ms |
| `rankedOpportunities` | ~19 ms |
| `getBriefWorkspace` | ~18 ms |
| `previewImport` 5000 rows | 13.8 s |
| `confirmImport` 5000 rows | **117.7 s** (~23 ms/row; per-row peer scan → quadratic — root-caused, NOT optimized: 500-row NFR holds at ~12 s < 60 s; 5000 completes correctly; 50-project-record scale frozen) |
| 10 parallel `createCompany` | 144 ms total, no conflicts |
| Company-search plan | Seq Scan at 67 rows — correct at this scale; GIN trgm indexes in place for growth |

No bottleneck at the frozen 50-project-record scale; no optimization applied (per
milestone discipline). Probe file deleted after recording; numbers above are
the record.

## 4. Verification gates (actual results)

| # | Gate | Result |
|---|---|---|
| 1 | migrate (dev + test) | `already up to date` (26) |
| 2 | seed twice (dev) | `seed ok` ×2 |
| 3 | verify | `verify ok` |
| 4 | SQL suite | Same run (6/6 incl. R-02 block) |
| 5a | vitest, empty test DB | **22 files / 295 passed / 1 skipped / 0 failed** |
| 5b | vitest, SEEDED scratch DB (CI simulation) | **22 files / 295 passed / 1 skipped / 0 failed** |
| 6 | tsc | Clean |
| 7 | build | `Compiled successfully` (middleware 34.2 kB, health + search + pipeline routes) |
| 8 | Docker/PG | `healthy`; `restart=unless-stopped` |
| 9 | Backup → isolated restore | 114,902-byte dump, 214-entry TOC, restore+checks ~2.5 s, integrity ok |
| 10 | HTTP smoke (final build) | boot line, health 200 + req-id + log line, login→search/pipeline/review 200, logout→401, anon search 307/401 |
| 11 | CI steps | All executed locally in order (bootstrap→build); provider run unverified (no remote) |

Residue: test DB 0 fixtures; `agency_intel_ci` + `agency_intel_perf` scratch
DBs dropped (only `agency_intel` + `agency_intel_test` remain); dev seed
intact (3/5/12/1); smoke sessions removed; no `.tmp`, no stray files; one
test-suite backup artifact pair retained as milestone evidence alongside the
legacy dump.

## 5. Auth + boundary confirmation (preserved, re-proved)

- Handler/gate parity holds including the two new endpoints (`/api/health`
  is the single documented public exception — infrastructure signal, no
  private fields, shape-tested).
- `checkOperatorToken` still closed-by-default; `AUTH_DEV_OPEN` unset;
  production boot gate now enforced for real (was test-only).
- Anonymous search/pipeline/review re-proved 307/401 on the final build;
  session login→logout→401 cycle re-proved.
- Loopback-only DB + app ports; no public exposure; no cloud; no new infra
  (pg_trgm ships inside the existing postgres image — not a new service).

## 6. Outstanding items & limitations

- **Off-host backup custody: none.** Local restore ≠ disaster recovery.
  RPO (≤24 h) is a proposal without a schedule; RTO (≤15 min) is proposed
  with ~3 s measured locally. congenial → CONDITIONAL verdict driver.
- CI provider execution unverified (no remote); workflow validated step by step.
- Disk-exhaustion drill skipped as unsafe.
- D-004/D-005/D-006/D-008, T-014 labor, R-05 attestation: unchanged, still open.
- Accepted dep risks: vitest-chain criticals + next/postcss (breaking-major fixes deferred).
- 5000-row import ≈ 2 min (correct, root-caused quadratic, intentionally unoptimized).

## Verdict: CONDITIONAL PASS

Every implementable requirement is done and evidenced; the condition is the
explicitly anticipated one — no off-host custody, no schedule, no provider-run
CI — plus the standing owner decisions. No critical invariant, security
guarantee, or gate failed. Milestone 4 NOT started; awaiting review.

| # | Work | Basis |
|---|---|---|
| S-1 | `scripts/backup.mjs`: version-matched `pg_dump -Fc` via container exec, manifest (timestamp/db/format/size/sha256/result, no secrets), integrity verify, isolated scratch restore + full integrity check, invalid-artifact failure path | §2 |
| S-2 | Health endpoint + request-ID middleware logging (redacted by construction) + boot validation log | §3 |
| S-3 | Compose restart-policy review; env validation wiring check | §4 |
| S-4 | vitest 3.2.7 upgrade (verified); next/postcss accepted-risk record | §4 |
| S-5 | Minimal CI workflow definition + local execution of every step | §5 |
| S-6 | Failure drills (real outage/shutdown/restore/config/session/concurrency/idempotency; disk-exhaustion explicitly skipped as unsafe) | §6 |
| S-7 | Performance benchmarks at seed scale + 50 generated projects (measured, no invented numbers, optimize only with evidence) | §7 |
| S-8 | Runbook + backup/restore doc + release checklist + this report | §8 |
