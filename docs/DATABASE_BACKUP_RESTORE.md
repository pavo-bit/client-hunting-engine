# DATABASE_BACKUP_RESTORE — PostgreSQL Backup & Recovery

> Local Docker PostgreSQL only. No off-host custody exists — see §6.
> Tool: `scripts/backup.mjs` (version-matched server tools via `docker exec`).

## 1. Backup

```powershell
node scripts/backup.mjs backup            # dev database (default)
node scripts/backup.mjs backup --target test
```

- Mechanism: `pg_dump -Fc` (custom format, compressed, single-transaction
  consistent snapshot) executed **inside** the `grayscales-pg` container
  (server tools 17.11 — no host tools, no version skew), copied to `backups/`.
- Output: `backups/<db>-YYYYMMDD-HHMMSS.dump` + `.manifest.json` sidecar
  (timestamp, database, format, bytes, sha256, postgres version, verification
  note). **Manifests never contain secrets.**
- Password handling: read from env/`.env` at runtime, passed via
  `docker exec -e` (transient exec environment, visible only to whoever can
  already `docker inspect` this host). Never printed, logged, or committed.
- Failure detection: non-zero `pg_dump`/`docker cp` exits fail loudly;
  dumps under 1 KB are rejected as suspicious.
- Frequency/retention (explicit operational settings, owner-adjustable):
  **manual before any risky operation + weekly**; keep the **last 4** dev
  dumps; the pre-migration legacy dump is never deleted without owner approval.

## 2. Verify (without restoring)

```powershell
node scripts/backup.mjs verify backups/<file>.dump
```

Recomputes sha256 against the manifest (tamper/corruption check) and parses
the table of contents with `pg_restore --list` (readability check). Garbage
files fail with `pg_restore: error: input file does not appear to be a valid
archive`.

## 3. Restore (isolated scratch only)

```powershell
node scripts/backup.mjs restore backups/<file>.dump --scratch <new-db-name> [--keep]
```

- The target **must not exist** and **must not** be a protected name
  (`agency_intel`, `agency_intel_test`, `postgres`, `template*`). The active
  dev database **cannot** be overwritten by this script — by construction, not
  by care.
- On `pg_restore` failure the fresh scratch database is **dropped again** —
  no partial restore is ever left behind (tested).
- Integrity checks after restore (read-only): migration count, company/claim
  counts, **exactly 12 source categories** (R-02), zero orphan claims.
- Default drops the scratch database afterwards; `--keep` leaves it for
  inspection (drop manually when done).
- Measured: ~115 KB dev dump restores in **~2.5 s** (integrity checks
  included). This is the measured RTO basis for a local restore — not a
  disaster-recovery promise (see §6).

## 4. Recovery objectives (PROPOSED — owner review required)

| Objective | Proposed target | Measured |
|---|---|---|
| RPO (max data loss) | ≤ 24 h (daily backup cadence once scheduled; currently manual-before-risk) | n/a (no schedule yet) |
| RTO (restore to verified scratch) | ≤ 15 min at current data size | **~3 s** end-to-end (backup ~1 s + restore+checks ~2.5 s at ~10 MB) |

These are proposals, not commitments. RPO is unmet until a schedule exists;
RTO will grow with data size and must be re-measured.

## 5. Encryption & key custody

- Backups at rest on this machine inherit the host's disk protection; **no
  backup encryption is implemented** and no off-host copy exists.
- If a backup ever leaves this machine, it MUST be encrypted first and the
  key held separately by the owner. No destination is designated — do not
  invent one. Record the gap, don't pretend otherwise (§6).

## 6. Known limitations (do NOT claim DR readiness)

1. **No off-host custody.** Fire/theft/disk-death of this machine loses data
   and backups together. Local restore ≠ disaster recovery.
2. **No schedule.** Backups are manual until someone owns a cadence.
3. **No managed key custody** (nothing to custody yet — see §5).
4. **Retention is manual** (keep last 4; legacy dump protected by policy above).
5. Point-in-time recovery (WAL archiving) is not configured — RPO cannot beat
   the last dump by design.
