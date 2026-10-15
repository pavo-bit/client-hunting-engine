# GRAYSCALES DISCOVERY API CONTRACTS

> **AS-BUILT CORRECTION (2026-10-15):** the endpoint sections below are the
> original design (Prompt 3) and are preserved as an audit record. Where the
> implementation differs, the **As-built** note is authoritative. Executed
> evidence for every shape: `docs/GRAYSCALES_DISCOVERY_FINAL_VERIFICATION_REPORT.md`
> and `docs/GRAYSCALES_DISCOVERY_TEST_TRACEABILITY.md`.
>
> As-built differences (all additive, all tested):
> 1. `POST /api/discovery/refreshes` 201 body also carries
>    **`stoppedBy`** (`completed|thresholds|deadline`), **`finalized`** (false =
>    the run was already closed by the reaper, in which case `status` is the
>    **stored** status) and **`unattributedSourceRecords`** (F13: items found
>    but not registered because their stored source key could not be resolved).
> 2. `GET /api/opportunities` items are flat rows
>    `{id, pipeline, opportunity_key, status, solution_status, first_seen_at,
>    created_at, company_id, company_name}` — **not** the nested
>    `company:{}` / `eligibility:{}` / `href` draft shape. `limit` defaults to
>    50 and clamps to 1..200; a `limit=0` falls back to the default.
> 3. `GET /api/opportunities/[key]` returns
>    `{opportunity, evidence[], eligibility_history[], lifecycle[]}`.
>    `eligibility_history` entries are `{id, opportunityId, version, decision,
>    gateReasons, policyVersion}` — camelCase, mapped explicitly.
> 4. `GET /api/discovery/refreshes/[id]` returns `{runId, runStatus, endState,
>    coverage, measures, shortfall}`.
> 5. `measures` additionally carries **`unresolved_opportunities`**,
>    **`unresolved_tasks`** (F7 split; `unresolved` remains their sum) and
>    **`measures_basis: "live_projection"`** (F8 — these are read-time
>    projections, not a frozen record of the run; the frozen per-run figures are
>    the `coverage` task ledger).
> 6. `POST /api/discovery/reap` (not in the draft) returns
>    `{dryRun, staleAfterMinutes, considered[], reaped[{runId, tasksFailed}]}`.
>
> Error shapes are unchanged: `{code, message}` with 400 `bad_json`, 401
> `unauthorized`, 403 `forbidden`, 404 `*_not_found`, 409 conflicts,
> 422 validation, 429 `rate_limited`, 500 `internal`.

> Design-only (Prompt 3). Follows verified repo conventions exactly:
> `requireOperatorApi` on every handler (401 JSON, never data); `requireSameOrigin`
> on all mutations (403); `auth.email` attribution precedence over client actor;
> `intakeErrorResponse` shapes; 201 on creation; offset+limit pagination
> (review-queue precedent: limit 1..200, offset ≥0). No scheduled-refresh or
> autonomous-outreach endpoints exist in this design.

## Conventions (all endpoints)

- Auth: `requireOperatorApi(req)` → 401 `{code:"unauthorized",
  message:"authentication required"}` when `!ok`. Mutations add
  `requireSameOrigin(req, auth)` → 403 `{code:"forbidden"}`.
- Actor: `(auth.email ?? actorOf(body))` — session identity wins.
- Errors: `{code, message}` + HTTP status via existing domain codes
  (400 bad_json, 404 *_not_found, 409 conflicts/gates_failed, 422 validation,
  429 rate_limited, 503 unavailable). No stacks, no secrets, no SQL.
- Pagination: `?limit=` (default per endpoint, clamp 1..200), `?offset=` (≥0,
  default 0); responses include `total` alongside capped `items`.
- Idempotency: repeat POSTs create NEW history rows (runs, versions) but ZERO
  duplicate domain entities (uniques arbitrate) — effect-idempotent,
  history-appending by design. No client idempotency keys (rejected as
  unnecessary mechanism; revisit only with evidence).

## Endpoints

### POST /api/discovery/refreshes (NEW — manual planned refresh)
Body: `{ tasks: [{adapterId, queryText, limit?, maxPages?}], actor? }`
(1..25 tasks; existing per-task bounds apply). Creates run row
(`status:'running'`) + task rows (all `pending`), executes sequentially in
request scope (existing synchronous pattern; 120 s overall budget), finalizes
with six §4A counters + end-state. Response 201:
`{runId, status, tasksPlanned, tasksDone, endState, measures}` — `measures`
and `endState` come from the same live projection as the status endpoint
below (frozen task yields + current opportunity states); child run rows stay
individually addressable. As-built delta (Prompt 5): task counts replace the
draft `counts` object; `error` surfaces via the run/status endpoints, not the
201 body. Validation: 422 bad_query/shape;
409 on concurrent identical plan only if a client supplies `planKey`
(PROPosal — default: allowed concurrent, uniques arbitrate). Existing
single-query `POST /api/discovery/runs` UNCHANGED (refreshes compose it;
neither duplicates the other).

### GET /api/discovery/refreshes/[id] (NEW — status + coverage)
Response 200: run row + `coverage:{total, pending, running, done, exhausted,
failed, skipped_low_yield}` + six counters + `shortfall:{pipeline, target,
actual, reason}` per pipeline (no silent transfer — shortfalls explicit).
404 unknown id. Read-only; no writes (audit-invariance holds).

### GET /api/opportunities (NEW — accumulated collection)
Query: `pipeline=` (required until O1; default `agency_partner`),
`status=`, `q=` (bounded substring over key/title/company, ≤200 chars),
`limit=`, `offset=`. Response 200: `{total, items:[{key, pipeline, title,
company:{id,name}, status, solution_status, eligibility:{decision, version,
gate_reasons}, first_seen_at, href}]}`. No new rows ever (projection).

### GET /api/opportunities/[key] (NEW — detail + history)
Response 200: record + evidence list (claim→snapshot→source) +
`eligibility_history[]` (all versions) + lifecycle transitions (from
`audit_log`) + related hypothesis/brief links if promoted. 404 unknown key.

### Reused (no contract change)
`POST /api/discovery/runs`, `GET /api/discovery/runs[/[id]]`,
`/api/candidates[/[id]/*]` (ambiguous-identity review),
`/api/evidence/*` + `/api/claims/*` (provenance/assessment),
`/api/review`-equivalent queue reads, `/api/auth/*`, `/api/health`
(public infrastructure exception, documented).

### Explicitly absent (forbidden by boundaries)
`POST /api/discovery/schedule`, `DELETE` bulk endpoints, send/submit-outreach
endpoints, pipeline-transfer endpoints, weight/threshold mutation endpoints.
