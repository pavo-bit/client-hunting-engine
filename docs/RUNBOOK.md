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

## 6. Incident triage (symptom → action)

| Symptom | Likely cause | Action |
|---|---|---|
| `/api/health` 503, `db.ok:false` | Postgres down | `docker start grayscales-pg`, wait `healthy`, re-check; counts must be unchanged |
| Pages show "Local database unreachable" | Same as above | Same as above (pages degrade to error states, no stacks) |
| Login 503 `auth_unavailable` | `.env` credential missing/mangled | `operator.mjs check .env`; re-provision; restart |
| Login 429 `rate_limited` | 5 bad attempts / 10 min | Wait, or restart app (ledger is in-memory by design) |
| Login 401 with correct password | Unescaped `$` in hash (mangled by Next expansion) | Re-paste from `operator.mjs hash`, exact bytes; `check` must say present |
| `verify` fails `source count` | Stale assertion (fixed R-02) — should not recur | Inspect, don't weaken; see R-02 report |
| `seed` fails mid-run | Whole batch rolled back (atomic) — nothing partial | Fix the cause, re-run; see R-03 report |
| Port 3101/5434 in use | Stale process | Find listener, stop it, restart |

## 7. Known recovery limitations

- No off-host backups; no schedule yet (manual). RPO/RTO are proposals —
  `docs/DATABASE_BACKUP_RESTORE.md` §4/§6.
- No metrics pipeline: error rates/latency are manual log inspection.
- Rate-limit ledger is in-memory (restart clears it).
- Disk-exhaustion behavior is untested (unsafe to test on this host).
