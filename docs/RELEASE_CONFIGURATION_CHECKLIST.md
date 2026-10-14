# RELEASE_CONFIGURATION_CHECKLIST — Pre-Exposure Review

> The application is LOCAL-ONLY. This checklist blocks any exposure until
> every item is verified. It is a gate, not a procedure — do not treat
> completion as deployment authorization (that needs a separate owner decision).

## Network & deployment boundary

- [ ] Served only on loopback (`127.0.0.1`); no public port mapping added to `compose.yaml` or start commands.
- [ ] `DATABASE_URL` / `TEST_DATABASE_URL` refuse non-loopback hosts (in `scripts/db.mjs` + every suite's guard).
- [ ] No cloud resources provisioned; no remote database configured.

## Secrets & credentials

- [ ] Production `.env` provisioned via `node scripts/operator.mjs init` (never the dev placeholder).
- [ ] `operator.mjs check` reports both values present.
- [ ] `OPERATOR_PASSWORD_HASH` pasted with `\$` escaping, byte-exact.
- [ ] `.gitignore` excludes `.env`, secrets, backups (verify before any `git init` + push).
- [ ] `OPERATOR_API_TOKEN` either empty (no bearer auth) or an explicit random service value — never a default.
- [ ] `AUTH_DEV_OPEN` unset (it is ignored in production, but must not be set anywhere near one).

## Boot & health

- [ ] Production boot prints `{"event":"boot",…,"auth_configured":true,"dev_open":false}` and stays up.
- [ ] Production boot WITHOUT secrets fails with `auth_not_configured` (tested in CI-suite; re-verify after env changes).
- [ ] `GET /api/health` returns 200 `ok` with no private fields.

## Data safety

- [ ] A verified backup exists: `backup.mjs backup` + `verify` green + manifest recorded.
- [ ] A scratch restore was verified after the last migration change.
- [ ] RPO/RTO proposals reviewed (`docs/DATABASE_BACKUP_RESTORE.md` §4); off-host gap explicitly accepted or closed.

## Quality gates

- [ ] `npx tsc --noEmit` clean; `npx vitest run` green; `npm run build` clean; `db.mjs verify` green.
- [ ] Anonymous access still 401s/redirects on a sample of pages + API routes.
- [ ] No-send scan green; R-05 QA attestation recorded (named, dated).

## Remaining blockers (pre-filled, all open)

- D-004/D-005/D-006/D-008 owner approvals; T-014 validation labor + QA assignee;
  off-host backup custody; metrics/alerting beyond manual log inspection.
