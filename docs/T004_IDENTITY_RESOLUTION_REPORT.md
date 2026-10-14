# T004_IDENTITY_RESOLUTION_REPORT — Canonical Company Identity & Dedup

> Date: 2026-10-13. Stack: Docker Compose postgres:17.11 exclusively (D-012). No ML, no fuzzy matching, no auto-merge inside intake, no outreach changes.

## Implementation and architecture

- `lib/resolve/names.ts` — name normalization (candidate generation only).
- `lib/resolve/hosts.ts` — shared/platform host denylist (28 bare hosts; subdomains still identify).
- `lib/resolve/engine.ts` — precedence (registry-scoped+type > domain-exact minus shared hosts > verified aliases > name-exact review-only), auto-merge gate (domain-exact + conflict-free + pending), `findCandidates` (idempotent upsert), `decideCandidate` (accept→merge txn / reject+reason / defer+reason), `reopenCandidate` (explicit, evidence reason, audit-preserved), `previewCandidate` (read-only impact), `getCandidateQueue` (canonical pairs + linked-row counts). Older record wins.
- `lib/resolve/detail.ts` — agency aggregate (identity, aliases+verification, discovery, candidates, absorbed, audit).
- Intake refinements (backward compatible): optional `registry_type` (validated, lowercased; CSV optional column — old 8-column files still pass), shared hosts never stored as `domain_norm` (registry identity stands alone, else 422 with guidance).
- Merge function `resolve_merge_company()` (migration 8): ordered locking, state/registry-conflict/alias-collision guards, FK repointing (discovery/research/claims/hypotheses/briefs/import rows), alias folding + preservation, archive+pointer, dual audit events. Snapshots stay attributed (immutability policy).

## Migrations and schema changes

- `20261013000002_resolution.sql` — `merged_into` + state checks, `match_candidate` + pair/rule unique index, merge function, RLS baseline. (Corrected pre-release re snapshots: repoint removed, disclosed.)
- `20261013000003_canonical_uniques.sql` — uniques scoped to canonical rows; registry scoped by (id, country); NULL countries never collide.
- `20261013000004_snapshot_delete_policy.sql` — UPDATEs blocked (except suppression); DELETEs permitted (cascade/takedown operability). T-002 suite updated accordingly.
- `20261013000005_resolution_evidence.sql` — `registry_type`, alias `verification`/`country_code`/`note`, candidate `reopen_reason`/`reopened_at`.
- Canonical ⟺ `merged_into IS NULL`. `discovery_record` doubles as the source-specific identity-observation store (no redundant table).

## Identity rules and candidate examples

- Same registry + jurisdiction + agreeing type → `registry_scoped` review (never auto; unreachable via intake due to canonical uniques — intake 409 is the live guarantee, predicate unit-tested).
- Same normalized domain (non-shared) → `domain_exact`; auto-merge only if registries compatible, else conflict-flagged review.
- Identifier hits a verified alias → `alias` review; unverified aliases ignored (tested).
- Same normalized name, different identifiers → `name_exact` review; similar-but-different names → nothing.
- Bare platform hosts (`linkedin.com`, …) → never domain identity; NULL domain stored.
- No identifiers → unresolved empty set; malformed → rejected at intake (422).

## API and dashboard routes

- `POST /api/resolve`, `GET /api/candidates`, `GET /api/candidates/[id]/preview`, `POST /api/candidates/[id]/decision`, `POST /api/candidates/[id]/reopen`, `GET /api/companies/[id]` — all server-side, parameterized, token-gated with the other mutating routes.
- `/agencies/[id]` (identity, aliases, candidates, history, resolution runner), `/resolve` (queue + preview dialog + accept/reject/defer + conflict override), directory names link to detail.

## Authorization and audit controls

- RLS + PUBLIC revokes cover `match_candidate`; unprivileged-role denial re-tested. All mutating endpoints behind `checkOperatorToken`; merge/decision/reopen each write audit events (override explicitly stamped); concurrent decisions serialize (row locks; second gets 409).

## Tests executed and exact results

- `tests/resolve.test.ts`: **30/30 pass** — predicates (conflict/type/hosts/gate), generation (exact/similar/conflict/cross-jurisdiction/idempotent/shared/unverified/malformed/unknown), decisions (accept+FK/alias/audit, reject/defer/409s, conflict block + override + audit note, alias continuity end-to-end, rollback, concurrent-once, alias collision, reopen lifecycle + audit, preview read-only + 404, queue counts).
- Full `npx vitest run`: **92/92 across 7 files** (T-002/T-003 intact incl. 5000/5001, races, idempotency).
- `db/tests/t002_verify.sql` via runner: green. `npx tsc --noEmit`: clean. `npm run build`: clean.
- Fresh-DB gate: dropped `agency_intel_test` → bootstrap → 11 migrations → re-migrate idempotent → suites re-green.
- HTTP round-trip (production build): resolve→1 candidate→preview (older wins)→accept→merged; detail/queue 200; smoke rows removed (seed count 3).
- Mid-task defects fixed with evidence: snapshot-repoint vs immutability (policy correction 8c), uuid casts in `least/greatest`, older-wins test ordering, shared-host intake rule, sidebar landmark (prior task), `/pipeline` DATE render (prior task).

## T-002/T-003 regression results

Untouched behavior, all green: 18 import tests (incl. boundary 5000/5001 after the optional-column change — old template files still validate), T-002 SQL suite, dashboard tests, auth tests. One deliberate contract narrowing: bare platform hosts no longer storable as `domain_norm` (was accepted in T-003); documented above.

## Build and type-check results

`tsc` clean, `next build` clean (22 pages + 7 API routes). No Supabase introduced (grep-verified across app/lib/db/tests); no delivery code (static scan incl. components).

## Known limitations and unresolved risks

- Domain ownership is not verified (syntax + shared-host rules only).
- Registry-type labels are free text (operator-spelled; lowercased).
- Shared-host list is a proposal seed — extend with evidence.
- Auto-merge path is defense-in-depth (unreachable via current intake); covered by gate unit tests + shared merge execution.
- No operator login (local-only); no fuzzy/ML matching by policy.

## Verdict: PASS

All acceptance gates hold with captured evidence: healthy Docker PG, fresh-DB init + rerunnable migrations, rules as specified, conflicts/reviews enforced, merges preserve provenance, auth tests green, 92/92 + tsc + build green, no Supabase, no outreach, no unrelated changes.
