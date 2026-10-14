# PROJECT_IMPLEMENTATION — How the System Will Be Built

> PROPOSAL unless noted. Current repo state (2026-10-12): empty workspace, no code — everything below is planned, not existing.
> Canonical requirements: `PROJECT_SPECIFICATION.md`. Data detail: `DATA_MODEL_AND_EVIDENCE.md`.

## 1. Module responsibilities

| Module | Owns | Must not own |
|---|---|---|
| `intake` | Manual entry, CSV import, validation | Scoring, outreach text |
| `discovery` | Adapter contract v1, registry, fixture, fetch guard (T-005) + GLEIF live adapter + bounded runs (T-006; no other live sources) | Claim semantics, live acquisition beyond one evaluated source |
| `research` | Permitted fetching, snapshot store | Hypothesis validation |
| `evidence` | Claims ledger, status, reliability/credibility, contradictions | Commercial math |
| `profile` | Business profile assembly | Project scoping |
| `hypothesis` | Hypothesis CRUD, validation gates | Capability catalog content |
| `catalog` | Grayscales capability entries | Prospect data |
| `project` | Project options, feasibility, assumptions | Score weights |
| `scoring` | score_v1 engine + gates + history (T-011; weights provisional D-006) | Gate overrides (forbidden), ML/probabilities (forbidden) |
| `review` | Queue, briefs, drafts (no send path) | Outcome analysis |
| `outcomes` | Send logs (manual), results, rejection/failure log, reports | Any send mechanism |
| `platform` | Config, secrets wiring, logging, audit, health | Business logic |

## 2. Module dependencies

`review → scoring → {hypothesis, project} → {profile, evidence, catalog} → {research, discovery, intake} → platform`. `outcomes` reads `review` outputs; `catalog` is referenced by `project` only. No cycles; `scoring` never calls `review` to mutate gates.

## 3. Proposed repository organization

```text
/ (root)
  AGENTS.md
  agents/...            # agent instructions
  docs/...              # authoritative documentation
  compose.yaml          # IMPLEMENTED D-012: postgres:17.11, localhost-only, pgdata volume
  .env / .env.example   # local-only defaults / safe placeholders (real secrets never committed)
  db/
    migrations/         # IMPLEMENTED: 10 ordered SQL files (schema source of truth)
    seed.sql            # IMPLEMENTED: deterministic synthetic seed (rerun-safe)
    tests/t002_verify.sql # IMPLEMENTED: live assertion suite (noaccess role)
  scripts/db.mjs        # IMPLEMENTED: bootstrap/migrate/seed/verify runner + schema_migrations
  backups/              # pre-migration dump (verified) — local-only artifact
  app/                  # IMPLEMENTED: App Router shell + intake workspace + read APIs
  components/
  lib/
    utils.ts            # cn() helper
    intake/             # T-003 server logic (validation, staging, commit)
    resolve/            # T-004 engine (in-progress; verdict open)
    dashboard/          # typed read fetchers + nav registry
  tests/                # vitest unit + integration (80/80)
```

Frontend stack (IMPLEMENTED, dashboard reconciliation 2026-10-13): Next.js
15.5.27 + React 19 + TypeScript strict + Tailwind CSS v4 + shadcn-style
primitives (Radix Slot/Dialog, cva/clsx/tailwind-merge) + lucide-react +
react-hook-form + zod (manual form; server revalidates) + TanStack Table v8
(directory + preview tables). Deliberately NOT added: recharts (no real
analytics — fabricated charts prohibited), TanStack Query (plain fetch
suffices; no server-state justification yet). TanStack Table pinned to v8
stable (v9 changed the API; no reason to chase the major).

Full dashboard (2026-10-13+): grouped dark-navy sidebar (6 groups, 22
sections) with live/partial/planned badges, agency-scoped header search,
breadcrumbs, not-found/error boundaries, read-only server-rendered pages
over typed fetchers (`lib/dashboard/queries.ts`, no new API routes), Radix
confirm dialog on import commit, honest PlannedPage for tasks. One defect
found and fixed in audit: raw pg DATE child crashed /pipeline (formatted at
render + regression test). See `docs/DASHBOARD_AUDIT_REPORT.md`.

Database access (IMPLEMENTED D-012 baseline, local Docker PostgreSQL 17.11):
RLS enabled on all tables with zero permissive policies + explicit
`REVOKE ALL ... FROM PUBLIC` (verified: unprivileged `noaccess` role gets
42501 on read and write). App uses the server-side owner connection
(`DATABASE_URL`) — never client code. Secrets in `.env` (local-only);
`.env.example` holds placeholders. Local workflow: `npm run db:up` →
`db:bootstrap[:test]` → `db:migrate[:test]` → `db:seed` → `db:verify` →
`npm test`. No remote database exists; non-local access stays disabled
(localhost-only binding; mutating APIs additionally honor OPERATOR_API_TOKEN
when configured; operator login still open).

If the eventual scaffold differs, update this doc — do not let code and doc diverge silently.

## 4. API and service boundaries

- IMPLEMENTED T-003 (Next.js 15.5.27 App Router; `next build` + `tsc --noEmit` clean):
  - `POST /api/companies` — manual create → 201 `{companyId}` | 409 duplicate | 422 field errors. Validates + normalizes server-side; writes company + manual discovery_record + audit in one transaction.
  - `POST /api/imports` — `{filename, csv}` → parse/validate/stage → 200 preview `{batchId, summary, rows}` | 422 file/row faults | 413 over 5000 rows or 10 MB. CSV-only enforced; nothing committed to `company`.
  - `GET /api/imports/[id]` — staged preview/summary.
  - `POST /api/imports/[id]/confirm` — explicit commit → partial-success summary (imported/skipped/invalid/dup/conflict counts + row reasons). Idempotent; concurrent confirms serialize on batch row lock.
  - `GET /import` — minimal operator page (manual form + file preview/confirm; React-escaped rendering, formula-risk badges).
- Atomicity (decided): PARTIAL SUCCESS via `import_batch`/`import_row` staging; confirm runs one transaction with per-row SAVEPOINTs; UNIQUE constraints are the final arbiter; preview conflicts rechecked at commit.
- Identity resolution (IMPLEMENTED T-004): `lib/resolve/` engine (precedence: registry-scoped+type > domain-exact minus shared hosts > verified aliases > name-exact review-only) + `resolve_merge_company()` transactional merge (ordered locking, conflict/alias guards, FK repointing, audit) + endpoints `POST /api/resolve`, `GET /api/candidates`, `GET /api/candidates/[id]/preview`, `POST /api/candidates/[id]/decision`, `POST /api/candidates/[id]/reopen`, `GET /api/companies/[id]` + detail/queue UI (`/agencies/[id]`, `/resolve`). Auto-merge: domain-exact + conflict-free only, older wins; never inside intake. See `docs/T004_IDENTITY_RESOLUTION_REPORT.md`.
- Live discovery (IMPLEMENTED T-006): GLEIF LEI adapter over `lib/discovery` contract + `POST/GET /api/discovery/runs` with bounded synchronous runs (limit≤25, ≤3 pages, 120s), idempotent per-record handling, conflict→review handoff, run history + detail UI on `/discovery`. See `docs/T006_DISCOVERY_SOURCE_REPORT.md`.
- Evidence ledger (IMPLEMENTED T-007): `lib/evidence/` (hash, deterministic assessment rules, idempotent ingestion, evidence links) + endpoints ingest/attach/assess/flag/claim-detail + claim review UI (`/evidence/[id]`, agency claims section). Statuses: observed/verified/corroborated/inferred/assumed + disputed/withdrawn/superseded (+computed stale); verified human-only; history append-only. See `docs/T007_EVIDENCE_LEDGER_REPORT.md`.
- DB access patterns: parameterized queries/ORM only; no raw string interpolation; intake writes idempotent on natural keys; evidence/brief reads join via IDs, never free-text scraping at request time.
- No outbound send endpoints. Draft rendering is pure (evidence + template → markdown), no side effects. Static no-send-path test covers `app/` + `lib/` + `components/`.

## 5. Source-adapter integration strategy

Shared interface (see `SOURCE_INTEGRATION_PLAN.md#adapter-interface`): `key(), isEnabled(), discover(query, ctx), normalize(raw), provenance(raw)`. Registry enables/disables per adapter + per-segment allowlist (allowlist operates on views of the worldwide agency segment: agency-type/country filters). Adapters must accept country/region parameters and must not hardcode a single jurisdiction, language, or registry (D-001/D-002). New sources require a `D-*` decision and a new `adapters/<s-xx>/` dir + contract tests.

## 6. Research and evidence pipeline

`discover → fetch (permitted, rate-limited) → snapshot (hash) → extract claims (status-labeled) → corroborate/contradict → profile → hypothesize → validate (gates)`. Each hop appends provenance; failures quarantine with cause class.

## 7. State transitions {#state-transitions}

- Company: `candidate → resolved → qualified | rejected (reason) → archived`.
- Hypothesis: `proposed → evidenced → validated | rejected → stale (on evidence expiry)`.
- Brief: `draft → in_review → approved | needs_work → sent(manual log) → replied/meeting/won/lost`.
- All transitions: actor, timestamp, from→to, reason, evidence refs → append-only audit table.

## 8. Error handling and retries

Bounded retries (PROPOSAL: max 3, exponential backoff + jitter) for network/rate-limit; no retry on terms-block/auth/injection-suspect → immediate quarantine + surface. Idempotency keys on intake/discovery jobs. Poison threshold → quarantine + alert to operator.

## 9. Configuration and secrets {#configuration-and-secrets}

- Config (non-secret): agency-segment defs (agency-type/country views on the worldwide segment), adapter toggles, weights version, retention windows — versioned file/DB table with change audit. Company records carry PROPOSAL `agency_type`/`country`/`region` fields per spec §2; no single-country defaults.
- Secrets: env/secret manager only (`SUPABASE_URL`, `<SERVICE_KEY>`, per-API keys). Never in docs, logs, snapshots, or repo. Local dev uses `.env.local` (git-ignored, never committed).

## 10. Background jobs

Start with simplest adequate mechanism (PROPOSAL: on-demand server execution + lightweight scheduler for MVP seed volumes). Introduce Postgres-backed queue only when real async workload requires it (record decision). No Kafka/Redis in MVP.

## 11. Testing strategy

- Unit: scoring math, dedup keys, validation gates, state transitions.
- Contract: each adapter vs. shared interface + normalization fixtures (recorded, no live calls in CI).
- E2E (minimal): intake → evidence → hypothesis → brief → outcome log on seed data.
- Security/policy: no-send-path test (grep + route inventory), injection-fixture test, secrets-scan.
- Database isolation: every suite shares ONE local PostgreSQL database, so test files run sequentially (`vitest.config.ts` -> `fileParallelism: false`). Fixtures must use a namespace no other suite cleans up - e.g. do not reuse `registry_id like 'RX-%'`, which `tests/resolve.test.ts` deletes.

## 12. Unified review queue (T-012, IMPLEMENTED)

`lib/review/queue.ts` exposes `getReviewQueue(pool, filters)` - a read-only projection over nine existing review workflows (identity candidates, claims awaiting assessment, hypotheses needing review, proposals, briefs, outreach drafts blocked on unverified assertions, unapproved catalog entries, scoring-gate exclusions, and stale decided artifacts). `app/review/page.tsx` renders it as the operator workbench with domain/priority/company/search filters, bounded pagination (max 200), per-item reasons, age, and a deep link into the owning workflow.

Design constraints that are enforced, not merely intended: no queue table and no writes (audit-log invariance is tested); priority is deterministic (blocking/high/normal/low/informational) and never derived from the opportunity score; staleness is delegated to `getBriefWorkspace` / `getProposalDetail` so the queue cannot drift from its domains; timestamps are serialized to ISO strings in the data layer; each source is isolated so a failure yields a partial result naming the source instead of a broken page. Actions are delegated to the existing authorized domain services - the queue duplicates no transition logic and has no send path. Search is bounded substring matching; no full-text index exists, so coverage is not claimed. See `docs/T012_REVIEW_QUEUE_REPORT.md`.

## 13. Observability and operations

Structured JSON logs (correlation ID, module, adapter, outcome, latency); error records with cause class; audit trail for state changes; health endpoint (PROPOSAL `/api/health`); operator runbook for quarantine triage and reprocessing.

## 14. Incremental implementation and verification

Follow `HIGH_LEVEL_PLANNING.md` phases and `LOW_LEVEL_PLANNING.md` `T-*` order; each increment independently reviewable with acceptance criteria + gate checks from [QUALITY_GATES.md](../agents/QUALITY_GATES.md).
