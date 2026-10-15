# QUALIFICATION API CONTRACTS (Part 2)

> Conventions follow `docs/GRAYSCALES_DISCOVERY_API_CONTRACTS.md` exactly:
> `requireOperatorApi` on every handler (401 JSON, never data);
> `requireSameOrigin` on all mutations (403); session identity wins over any
> body actor; `{code, message}` errors (400 bad_json, 401, 403, 404, 409, 422);
> offset+limit pagination with totals. No generated client types are used
> anywhere in this project (no codegen in `package.json`, `zod` present but
> unused) — these handwritten contracts, pinned by
> `tests/qualification_routes.test.ts`, are the specification.

## POST /api/qualification/assess — run one assessment (201)

Body: `{ opportunityId: uuid (required), policyVersion?, catalogVersion?,
rubricVersion?, capacityVersion?, operatorAnswers?: object, asOf?: iso,
requiredUsable?: number, idempotencyKey? }`. Omitted versions resolve to the
ACTIVE version of each kind; when none is active → 409
`no_active_reference` (an invented default is never substituted). Bad uuid →
422 `bad_id`. Unknown opportunity → 404. Inactive explicit version → 409/422
from the engine. Response 201: `{ assessmentId, version, caseId, snapshotId,
outcome, composite, band, replayed }`. A repeated idempotency key replays the
recorded assessment (`replayed: true`).

## GET /api/qualification/cases — case queue (200)

Query: `status=` (discovered|assessing|assessed|rejected|archived, else 422
`bad_status`), `drifted=true` (drift-flagged only), `limit=` 1..200 (default
50), `offset=` ≥0. Response: `{ total, limit, offset, items: [{ case_id,
case_ref, discovery_opportunity_id, discovery_opportunity_key, pipeline,
status, discovery_updated_at, drift_detected_at, latest_sequence, created_at,
updated_at, created_by, assessments (count), open_tasks (count) }] }`.

## GET /api/qualification/cases/[id] — case detail (200)

Bad uuid → 422 `bad_id`; unknown case → 404 `case_not_found`. Response:
`{ case, snapshots[] (id, schema_version, row_hash, captured_at, captured_by,
reason), assessments[] (id, version, all cited versions, as_of,
snapshot_hash, code_version, input_snapshot, decided_by/at, note),
research_tasks[] (full decision-value shape), staleness (latest assessment) }`.
Assessment score bodies are read through this route's `assessments` rows only
by id — full score JSON lives in `p2.case_assessment.assessment`.

## PATCH /api/qualification/research/[id] — task workflow (200)

Body: `{ status, notes? }`. Allowed: open→accepted|dismissed,
accepted→done|dismissed, dismissed→open; anything else → 409. Bad uuid → 422.
Unknown task → 404. Attribution is the session operator. Response: the task
row.

## Explicitly absent

Score-computation endpoints without assessment persistence (scoring only
exists inside an assessment run); task auto-execution; bulk transitions;
weight/threshold mutation (versions are immutable once stored; publication is
via the reference lifecycle, not HTTP).
