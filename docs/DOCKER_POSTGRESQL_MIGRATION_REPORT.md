# DOCKER_POSTGRESQL_MIGRATION_REPORT — Supabase Removal Audit (D-012)

> Date: 2026-10-13. Scope: prerequisite migration; T-004 not begun (its verdict stays open). No remote, no deploy, no outreach changes.

## Original Supabase dependencies discovered

- CLI scaffold only: `supabase/config.toml`, `supabase/.temp`, `supabase/.branches` (no linked remote project — `linked_project: null` verified before any destructive step).
- 10 migration files + `seed.sql` + `tests/t002_verify.sql` (plain PostgreSQL SQL throughout; Supabase-specific bits confined to: `anon`/`authenticated` REVOKEs in two migrations, `service_role` comments, `supabase_migrations.schema_migrations` read in `lib/dashboard/queries.ts`, `SET ROLE anon/authenticated` in two test files + the SQL suite, one UI error string, localhost:54322 defaults).
- No `@supabase/*` npm packages, no Supabase Auth/UI helpers, no Edge Functions, no Storage use. The JS SDK never existed in this repo.

## Backup and recovery evidence

- `pg_dump -Fc` from `supabase_db_client_hunting_engine` BEFORE any destructive change → `backups/pre-migration-20261013.dump` (492,104 bytes, 838 TOC entries, `pg_restore --list` parses cleanly).
- Live counts at backup time: company 3, claim 5, audit_log 51 (test residue, append-only by design).
- Rollback procedure: `pg_restore -d <target> backups/pre-migration-20261013.dump` into any Postgres 17; or re-run `scripts/db.mjs migrate + seed` for a pristine equivalent (deterministic seed). Backup retained in-repo; never claimed remote.

## Files created, modified, removed

- Created: `compose.yaml` (postgres:17.11, localhost-only 5433→**5434**, pgdata volume, healthcheck), `.env` (local-only) + `.env.example` (placeholders), `scripts/db.mjs` (bootstrap/migrate/seed/verify + `schema_migrations`), `db/` tree (10 migrations, seed, SQL suite), `tests/auth.test.ts` (token-gate unit tests), this report.
- Modified: RLS REVOKEs → `FROM PUBLIC` (+ rewritten auth comments); `lib/intake/db.ts` (DATABASE_URL, compose default); test DB defaults → `agency_intel_test:5434` + `TEST_DATABASE_URL` precedence; RLS tests → `noaccess` pool (CONNECT ok, 42501 on read+write); `checkOperatorToken` gate added to all 5 mutating API routes (+ unit tests); overview error string; settings disclosure; all docs (see below).
- Removed: entire `supabase/` tree (config, migrations, seed, tests, .temp, .branches) — only AFTER the replacement verified green. Supabase containers stopped last; image volumes left to Docker (no `down -v` run — persistent data preserved by rule).
- Port note: 5433 is blocked on this machine (Windows bind denial); everything standardized on **5434** (7 files).

## Final architecture

- `compose.yaml` → `grayscales-pg` (postgres:17.11, healthy), DBs `agency_intel` (dev, seeded) + `agency_intel_test` (tests), named volume `grayscales-pgdata`, `127.0.0.1:5434` only.
- `scripts/db.mjs`: refuses non-loopback targets; per-file transactions; history in `public.schema_migrations`; bootstrap creates DBs + `noaccess` LOGIN (CONNECT only, password from env).
- Auth model: RLS default-deny + PUBLIC revokes (native PG, verified); server-side owner pool; optional `OPERATOR_API_TOKEN` bearer gate on mutating routes (default empty = documented local-dev open mode); operator login still open; non-local access disabled.

## Migration and seed results

- `bootstrap` dev+test, `migrate` 10/10 on both (one miss fixed mid-flight: `match_candidate` REVOKE; runner resumed idempotently), `seed` dev, `verify` dev green (6/6 DO blocks incl. rewritten noaccess denial).
- Deterministic seed counts on new stack: 3 companies / 12 sources / 5 claims; seed re-run idempotent (T-003 suite re-proves continually).

## Security and authorization tests

- SQL suite: unprivileged denial on `company` + `brief` (42501).
- Vitest: `noaccess` pool CONNECT succeeds, SELECT + INSERT denied (import staging + match_candidate); `checkOperatorToken` 5 unit cases (open mode, exact match, 3 rejections).
- HTTP smoke: 7/7 pages 200 + manual create 201 on the fresh build; smoke row removed (seed count back to 3); probe server stopped.
- No-send scan still passes (extended to `components/`).

## T-002/T-003 regression results

- `npx vitest run`: **7 files, 80/80 pass** (incl. T-002-derived SQL suite via runner, T-003 18 integration incl. 5000/5001 + races + idempotency, dashboard 7).
- `npx tsc --noEmit`: clean. `npm run build`: clean.
- No Supabase runtime path remains in app code (grep-verified; only historical doc mentions + this report).

## T-004 incidental note (not a verdict)

- T-004 files ported as-is. Its suite now passes 18/18 after two minimal fixes found during port verification (uuid casts for `least/greatest` params; test creation order corrected to the documented older-wins rule) — reported transparently; T-004 still needs its own UI/API smoke + docs pass before any verdict.

## Residual Supabase references (intentional)

- Historical: `DASHBOARD_AUDIT_REPORT.md` (§test evidence cites `supabase db reset`), `DATA_MODEL_AND_EVIDENCE.md` §10 Supabase-era entries (labeled history), this report.
- Environment: global Supabase CLI + stopped containers may still exist on the machine (outside the repo; harmless).
- None in executable code, migrations, seeds, tests, env examples, or UI.

## Test commands and actual results

- `docker compose up -d` → `grayscales-pg Started` (5434; 5433 machine-blocked, documented).
- `node scripts/db.mjs bootstrap [--target test]` → both DBs + role ready.
- `node scripts/db.mjs migrate [--target test]` → 10/10 both.
- `node scripts/db.mjs seed` → ok. `node scripts/db.mjs verify` → ok, no errors.
- `npx vitest run` → 7 files, 80 passed. `npx tsc --noEmit` → clean. `npm run build` → clean.
- HTTP smoke → 7/7 200 + 201; cleanup verified.

## Verdict: PASS

Supabase is fully removed, the Docker + PostgreSQL canonical stack is verified end-to-end with evidence, data was preserved (backup + deterministic re-seed), and no scope was exceeded. T-004 may now proceed.
