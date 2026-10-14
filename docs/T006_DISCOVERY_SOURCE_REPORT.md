# T006_DISCOVERY_SOURCE_REPORT — First Real Adapter: GLEIF LEI Index

> Date: 2026-10-13. Selection gate PASS (see `docs/T006_SOURCE_SELECTION.md`). No credentials created; no scraping; no outreach changes.

## Verdict: PASS

## 1. Source-selection evidence and rationale

GLEIF selected after live verification: keyless `GET api.gleif.org/api/v1/lei-records` → HTTP 200, ~3.46M records, JSON:API + pagination; official site confirms production status (since 2020) and open-data positioning. Search dialect corrected by evidence (`filter[entity.legal-name]` → HTTP 400; `filter[fulltext]` → verified working). Rejected with cited evidence: OpenCorporates (official docs: API key required → external account, forbidden), Companies House (registration + app credentials, UK-only scope mismatch), agency directories/social/paid (no permitted programmatic access; manual fallbacks stand).

## 2. Verified access method and restrictions

Public open-data HTTPS API, no key/registration/cost. Rate limits: none published on reviewed pages (UNVERIFIED) — mitigated by ≤25/page, ≤3 pages/run, 120s timeout, 429 backoff (max 2 retries), fixture-backed tests. Terms: open-data use; no stated commercial prohibition found. Worldwide coverage; per-record jurisdiction + legal-address country.

## 3. Files changed and migrations added

- Created: `lib/discovery/adapters/gleif.ts`, `lib/discovery/http.ts` (guarded fetch, manual same-host-https redirects ≤2, abortable backoff, body-free diagnostics), `lib/discovery/run.ts` (bounded sync orchestrator), `lib/discovery/production.ts` (GLEIF-only registry), `app/api/discovery/runs[/[id]]`, `components/discovery-run-form.tsx`, `tests/gleif.test.ts`, `tests/fixtures/gleif/*` (1 real recorded + 4 crafted/labeled), this report + selection doc.
- Modified: `createCompany` (+optional provenance param, defaults preserve contracts), intake `registry_type` passthrough (already modeled), `/discovery` workspace, Sources UI split, docs (plan register, spec plan S-02, implementation, data model, LOW_LEVEL, D-014).
- Migrations: `20261013000006_discovery_runs.sql` (`discovery_run`, `discovery_run_item`, `source_record_id` + partial unique, `gleif-api` source row), `20261013000007_source_kinds.sql` (category vs connector — preserves the exact-12 invariant).
- No contract changes (pure additions: `preview`/`reopen` endpoints were T-004).

## 4. Adapter and registry integration

`gleif-lei` v0.1.0, S-02, capabilities [discover, health], registered only in production wiring (fixture stays test-only). Config: `{}` only (unknown fields rejected — secrets unconfigurable by design). Empty-text guard blocks bare index scans.

## 5. Normalization and provenance behavior

LEI→`registry_id` (+`lei` type), legal name, jurisdiction/country (+alpha-2 validation), region; agency always `other_digital` + explicit warning; domain/website → missingFields (never invented); non-ACTIVE status → warning; id-less records → `unknown` → skipped-invalid downstream. Provenance (adapter/version/record/self-URL/timestamp) survives into `discovery_record` + run items.

## 6. Persistence, deduplication, identity handoff

Runs persist with counts; items reference companies/candidates; idempotency via `UNIQUE(source_key, source_record_id)` + pre-check (reruns: duplicates, zero new). 409s run T-004 resolution with auto-merge disabled → conflict items with candidate links. Established records never updated (verified live). Each record commits independently; crashes leave `running` (documented, no resume).

## 7. Dashboard workflow

`/discovery`: live-adapter card (capabilities/limits), bounded run form, run history, run detail (items + warnings + company/review links), existing records table. Synchronous execution only — no scheduler/queues; client abort is best-effort, server timeout enforced.

## 8. Security and compliance controls

Untrusted JSON:API tolerated (malformed fixtures); fetch guard on every hop; no credentialed requests (no Authorization header exists); bodies excluded from diagnostics (tested with planted secret); no arbitrary-URL fetching (fixed base + parameterized filters only); token gate on POST; RLS baseline covers new tables (verified via suite + manual 201 path); local-only posture unchanged.

## 9. Tests executed with exact results

- `tests/gleif.test.ts`: **19/19** (contract, mapping incl. real KOTZILLA record, empty, 2-page walk, malformed tolerance, empty-query guard, 429→success, 429-exhausted, 500/400/403 mapping + single-call proof, redaction, cancel, registry timeout, host pinning, 3 redirect cases, run persist/idempotent-rerun, conflict handoff + untouched canonical, failure recording + redaction at rest, partial counts, route-gate static).
- Full `npx vitest run`: **9 files, 129/129** (+1 opt-in skip). `tsc` clean. `npm run build` clean. SQL suite green via runner.
- Mid-task fixes: query-length guard vs own tests (relaxed to non-empty with rationale), truncated fixture files (rewritten + parse-verified), test isolation (fixture-LEI cleanup), 12-category invariant (source kinds migration).

## 10. Live smoke-test result

- Opt-in (`GLEIF_LIVE_SMOKE=1`): real search `KOTZILLA` limit 2 → ok, 20-char LEI ids, api.gleif.org provenance URLs, `lei` typing — PASS (802ms).
- Production-build HTTP round-trip: `POST /api/discovery/runs` → status ok, found=1 new=1; history recorded; `/discovery` 200 — PASS. Live-created rows removed afterward (seed count verified 3).

## 11. Regressions, type-check, build

T-002 (SQL suite) + T-003 (18, incl. 5000/5001) + T-004 (30) + T-005 (19) + dashboard/auth all green in the 129. No Supabase, no scraping, no outreach introduced (scans green).

## 12. Known limitations and next recommended task

- Agency yield expected low (LEI skew); monitor per-run counts before depending on it.
- Rate limits unverified; no resume after crash; no scheduler (by design).
- `lookup` capability unimplemented; DNS TOCTOU documented for future live adapters.
- Next: **T-007** (evidence pipeline depth: fetch policy + snapshot store around discovered records).
