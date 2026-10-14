# DATA_MODEL_AND_EVIDENCE — Conceptual Model and Provenance

> IMPLEMENTED (T-002/T-003, re-verified 2026-10-13 on Docker PostgreSQL 17.11 after D-012 Supabase removal): migrations `db/migrations/` (10 files), seed `db/seed.sql`, assertions `db/tests/t002_verify.sql`, runner `scripts/db.mjs` with `schema_migrations` history. Deviations from the earlier proposal are marked IMPLEMENTED below; remaining ideas stay PROPOSAL. Canonical requirements: `PROJECT_SPECIFICATION.md` §4.3. Scoring use: `SCORING_AND_OPPORTUNITY_MODEL.md`.

## 1. Entities and relationships

```text
Source ──< Snapshot ──< Claim ──< Hypothesis ──< ProjectOption ──< Brief ──< OutcomeLog
Company ──< Snapshot | Company ──< Claim | Company ──< Profile | Company ──< Brief
Capability ──< ProjectOption | Segment ──< Company (qualification) | AuditLog (all transitions)
```

- **Company** (canonical): one row per real business; identity via verified domain / registry ID / handle.
- **Source**: adapter key + reliability prior (A–D, separate from per-item credibility).
- **Snapshot**: immutable raw capture (URL/endpoint, timestamp, hash, bytes ref, retention class).
- **Claim**: single assertion with status + provenance. One claim → one snapshot minimum.
- **Hypothesis**: candidate opportunity; links supporting + contradicting claims.
- **Capability**: Grayscales service entry.
- **ProjectOption**: scoped proposal linking hypothesis + capabilities.
- **Brief**: frozen review package (snapshot of inputs + rendered markdown).
- **OutcomeLog / FailureLog**: manual send/outcome/rejection entries.
- **AuditLog**: append-only transitions, merges, reviews.

## 2. Identifiers

- Canonical company: uuid PK `gen_random_uuid()` (IMPLEMENTED; earlier ULID proposal superseded — native type, no app-side ID generation needed).
- All other entities: uuid PKs (IMPLEMENTED). Briefs use human refs `BR-YYYY-NNN` as PK (IMPLEMENTED, `brief.ref`).

## 3. Tables (IMPLEMENTED — see migrations; verification §10)

| Table | Key fields | Constraints / indexes |
|---|---|---|
| `company` | id, name, domain_norm, registry_id, registry_type, agency_type, country, country_code, region, website_url, discovery_status, rejected_reason, merged_into | Canonical ⟺ merged_into IS NULL. Partial UNIQUE(domain_norm) + UNIQUE(registry_id, country_code) over canonical rows only (T-004 scoping); CHECKs as before + no-self-merge + merge-state |
| `company_alias` | canonical_company_id, alias_type, alias_value, verification, country_code, note | UNIQUE(alias_type, alias_value); verification verified/unverified (alias rule uses verified only); merge history preserved |
| `match_candidate` (T-004) | company_a/b, rule, detail, conflicting_registry, status, decided_by/at, decision_reason, reopen_reason/at | Pair+rule unique index; regenerate never resurrects decided rows; reopen is explicit |
| `source` | key, category S-01..S-12, reliability_prior A–D, enabled | PK(key); CHECK category (exactly the 12 — Reddit/YouTube unrepresentable) |
| `discovery_record` | company_id, source_key NULL (NULL = manual entry), collection_method, retrieval_status | FKs; INDEX(company_id, source_key) |
| `research_run` | company_id, status, failure_class, attempts | FK; INDEX(company_id) |
| `snapshot` | company_id, source_key, research_run_id, url, fetched_at, sha256, store_ref, content_excerpt ≤2000B, retention_class, suppressed | FKs; INDEX(company_id, fetched_at); trigger-immutable except takedown flag |
| `claim` | company_id, snapshot_id (mandatory), text, status, reliability A–D, credibility 1–5, observed_at, expires_at | FKs; INDEX(company_id, status); CHECK ranges |
| `hypothesis` | company_id, title, opportunity_category, status, confidence_rationale, rejection_reason | INDEX(company_id, status); rejection-needs-reason |
| `hypothesis_evidence` | hypothesis_id, claim_id, polarity | PK both; same-company trigger |
| `capability` | key, name, entry_criteria, is_placeholder | Seeded rows PLACEHOLDER (D-004 open) |
| `project_option` | hypothesis_id, scope_in/out, milestones, effort range, feasibility, capability_fit, assumptions (required), impact_note, cost range + currency, dependencies, validation_questions | CHECK effort/cost ranges |
| `project_capability` | project_option_id, capability_key | PK both |
| `score_run` | hypothesis_id, weight_version, fit/evidence/opportunity/feasibility/timing, deductions, total GENERATED, band GENERATED (provisional thresholds, D-006), gates_passed, explanation ≤8000B | total always consistent by construction |
| `brief` | ref, company_id, hypothesis_id, score_run_id, frozen_inputs_hash, markdown, status, reviewer | PK(ref); freeze-hash recorded |
| `outreach_draft` | brief_ref, channel, subject, body, is_human_send_only=TRUE (pinned) | No sent-at/status columns by design — no delivery path |
| `outcome_log` | brief_ref, sent_at_manual, channel, outcome, rejection_code, recorded_by | Manual records only |
| `audit_log` | entity, entity_id, actor, from→to, reason | Trigger append-only for granted roles (see §8) |
| `failure_log` | entity, cause_class, detail, resolved | INDEX(cause, resolved) |
| `discovery_run` / `discovery_run_item` (T-006) | run status/counts/error; per-record outcome + warnings + company/candidate links | Bounded JSON; runs never resume (rerun is idempotent) |
| `claim.predicate` + `needs_review` (T-007) | claim category; human triage flag orthogonal to status | Suggested vocabulary documented |
| `claim_assessment` (T-007) | claim transitions with rationale/actor/auto flag + history | Append-only for UPDATEs; DELETE permitted for explicit removal (D-011 extension) |
| `claim_evidence` (T-007) | claim↔snapshot/claim links with polarity + note | Exactly-one-target; cascades with company removal |
| `discovery_record.source_record_id` (T-006) | stable per-source id | UNIQUE(source_key, source_record_id); idempotency key |
| `source.kind` (T-006) | category (policy, exactly 12) vs connector (live instance) | Keeps the 12-category invariant exact |
| `import_batch` (T-003) | filename, file_sha256, total_rows, status draft/committed/discarded, created_by, committed_at | Staging header for preview→confirm; same RLS baseline |
| `import_row` (T-003) | batch_id, row_number, raw (≤20000B), status, error, formula_risk, company_id | UNIQUE(batch_id, row_number); INDEX(batch, status); staged rows, never silent drops |

T-002 contracts unchanged by T-003 (additive migration only). Candidate-table proposal superseded by the above. Not implemented: trigram name index (PROPOSAL, add when fuzzy search lands in T-004).

## 4. Provenance and claim status

- Every material claim: `snapshot_id` + retrieval timestamp + adapter version + claim status.
- `observed`: directly seen in snapshot. `corroborated`: ≥2 independent sources agree. `inferred`: reasoning over observations (must cite them). `assumed`: taken without direct evidence (requires assumption note; blocks `validated` until corroborated).
- Source reliability (A = official registry … D = unverified social) vs. information credibility (1 = confirmed … 5 = doubtful) recorded separately on each claim.

## 5. Timestamps and freshness

- `observed_at` (event time) vs. `fetched_at` (capture time) vs. `expires_at` (freshness horizon per claim type, PROPOSAL defaults in code config). Expired claims flip dependent hypotheses toward `stale`; briefs show staleness banner.

## 6. Snapshot retention {#retention}

- PROPOSAL: raw snapshots retained per class (registry: long; social: platform-policy-bound; fetched pages: TBD window D-008). PII minimized at capture; takedown/opt-out → suppress + tombstone, keep hash for audit unless deletion legally required (human decides; TBD legal review).

## 7. Contradiction handling

- Contradicting claims linked with `contradicts`; briefs render both; validation requires reviewer acknowledgement of open contradictions. Deleting/suppressing contradiction rows forbidden (app role lacks DELETE; test enforces).

## 8. Audit history and lifecycle

- All status transitions, merges/splits, reviews, outcome edits → `audit_log` with actor + reason + evidence refs. Merges preserve losing IDs as aliases; splits reference parent.
- IMPLEMENTED: `t002_guard_audit_append_only()` trigger blocks UPDATE/DELETE for all table-granted roles (verified live). HONEST LIMITATION: table owners / superusers / DDL holders can still modify data — this is tamper-evidence for the app role, not absolute immutability.

## 9. Transaction requirements

- Intake row, dedup merge, hypothesis validation, brief freeze, outcome write: each in a single DB transaction; brief freeze verifies input hash inside the transaction (PROPOSAL at app level — T-002 covers DDL constraints; app-side transactions land in T-003+).

## 10. T-004 identity model (DECIDED-BASELINE D-011, implemented + tested)

- **Canonical identity:** a company row with `merged_into IS NULL`. Merged losers become `archived` + `merged_into`, keep their rows, and gain alias records. No canonical pair shares a domain or a (registry, country) pair (partial uniques).
- **Precedence:** jurisdiction-scoped registry (+ type agreement when both types stated) > exact normalized domain (skipped on shared/platform hosts) > verified aliases > exact normalized names (review only).
- **Never:** auto-merge on names alone; merge on shared-host domains; treat syntax as ownership; ML/fuzzy matching.
- **Conflicts:** differing registry IDs (jurisdictions not provably different) or same number under conflicting types block auto-merge and force review; human override requires explicit `allowConflict` and is audit-stamped.
- **Observations:** `discovery_record` rows are the source-specific identity observations (method/source/provenance per record); claims carry supporting evidence; `match_candidate.detail` records the deterministic reason.
- **Reopening:** regenerate is idempotent and never resurrects decided rows; only `reopen` with new material evidence returns a candidate to pending, preserving the prior decision + reason in `audit_log`.
- **Merge semantics:** one transaction, ordered locking, per-side validation, child rows repointed (discovery/research/claims/hypotheses/briefs/import rows), alias histories folded, snapshots stay with their original record (immutability policy), two audit events. Older record wins for stable identity.
- **Unresolved:** records with no matches stay as-is (empty candidate set); no forced matches.

## 11. Verification record (2026-10-13; Supabase-era entries kept for history, D-012 current)

- `supabase start` on empty volumes: 6/6 migrations + seed applied cleanly.
- `supabase db reset --yes` (target confirmed local, project never linked): clean re-apply, `"target":"local"`.
- `supabase/tests/t002_verify.sql` via psql: 6/6 DO blocks pass — seed counts (3 companies / 12 sources / 5 claims), provenance chains, no-delivery-path schema scan, negatives (dup domain, bad status, bad category, cross-company link, snapshot delete, audit update all rejected), RLS/REVOKE denial for anon + authenticated.
- Extra live checks: duplicate `registry_id` rejected (`company_registry_id_uidx`); seed re-run fully idempotent (all `INSERT 0 0`, counts stable); probe rows removed, seed state intact (3 companies).
- RLS model verified: RLS enabled on all tables, zero permissive policies, explicit `REVOKE ALL ... FROM PUBLIC` — the unprivileged `noaccess` role (CONNECT only) gets SQLSTATE 42501 on reads and writes. App path is the server-side owner connection (no client use; real secrets in `.env`, never committed).
- Re-verified 2026-10-13 post-migration (second clean `db reset` + suite + REST checks): 6/6 DO blocks pass; anon REST GET → 42501, anon REST POST → denied, company count unchanged at 3. No fixes needed; no policies weakened.
- Re-verified 2026-10-13 post-D-012 (Docker Compose postgres:17.11 + `scripts/db.mjs`): bootstrap dev+test, 10/10 migrations, seed, `db/tests/t002_verify.sql` green (6/6 DO incl. noaccess denial), 80/80 vitest, tsc + build clean, HTTP smoke (7 pages + manual 201) green. Supabase history superseded, not deleted from memory: see `docs/DOCKER_POSTGRESQL_MIGRATION_REPORT.md`.

## 12. T-012 review queue model (D-017, implemented + tested)

- **No new entity.** The unified review queue adds no table, no column and no migration. It is a read-model projection in `lib/review/queue.ts` assembled from nine bounded parameterized queries at read time. Every projected field (identity, company, title, reason, domain status, priority, timestamps, staleness, deep link) is derivable from existing rows, so persisting it would create a reconciliation duty and a competing source of truth.
- **Item identity.** `key = "<domain>:<type>:<recordId>"` - stable across reads, independent of ordering, and the deduplication key. Nine domains: `identity`, `evidence`, `hypothesis`, `proposal`, `brief`, `draft`, `catalog`, `gates`, `stale`. Sources are unique by construction; deduplication on `key` is defence in depth.
- **Priority is derived, never stored.** blocking / high / normal / low / informational, assigned by documented deterministic rules from domain state. The opportunity score is NOT an input - a low-scoring opportunity can carry an urgent integrity problem and a high-scoring one can be blocked by unresolved identity evidence.
- **Staleness is computed, never stored.** Brief and proposal staleness are read from the owning helpers (`getBriefWorkspace`, `getProposalDetail`); score staleness mirrors `rankedOpportunities`' two documented conditions. A stale artifact keeps its approved/decided status; the queue flags drift and demands re-review, it never resets approval.
- **Lifecycle ownership unchanged.** Queue entries appear and disappear purely as domain records change. There is no queue-side completion flag, no snooze, no assignment and no reopening rule of its own; reopening stays with the domain (e.g. T-004 `reopenCandidate`, T-008 supersession on new material evidence).
- **Privacy boundary.** Outreach bodies, pipeline notes and operator notes are never projected. Only brief ref, channel, version and the presence of unverified points are exposed.
- **Audit.** The queue performs no writes; reads leave `audit_log` unchanged (tested). Actions are delegated to the existing authorized domain services, which retain their own validation and audit behaviour.
- **Serialization.** All timestamps are normalized to ISO strings in the data layer, because `pg` returns `Date` objects for `timestamptz`/`date` and those crash React server components.

## 13. Verification record addition (2026-10-13, T-012)

- `tests/review.test.ts`: 20/20. `npx vitest run`: 15 files, 222 passed, 1 skipped (opt-in), 0 failed, reproduced twice.
- `tsc --noEmit` clean; `npm run build` clean; `node scripts/db.mjs migrate` `already up to date` (no migration added); container healthy; test-DB residue 0.
- HTTP round-trip on the production build (`/review` 200; populated inbox; filters; validation messages; empty state; no POST form); smoke rows removed.
- **R-02 RESOLVED 2026-10-13 (see `docs/R02_SOURCE_CATEGORY_VERIFICATION_REPORT.md`).** The `source` registry holds two kinds of row and they must be counted separately: 12 locked **category** rows (S-01..S-12, migration 2) and additional **connector** rows registered under a category (e.g. `gleif-api`, migration 6). `db/tests/t002_verify.sql` now asserts `count(*) FILTER (WHERE kind = 'category') = 12`, keeps the connector count as reported evidence, and adds block 1b proving the `gleif-api` connector is present and that adding a connector does not change the category count. `tests/source_registry.test.ts` (5 tests) enforces the same rules in the standard Vitest run. The earlier `source count 13, want 12` failure was an assertion defect, not a data defect.
- **R-03 RESOLVED 2026-10-13 (see `docs/R03_SEED_COMPATIBILITY_REPORT.md`).** `db/seed.sql` was written at T-002 and had drifted in two places after T-008: the hypothesis status `evidenced` (removed from the enum; T-008 migration 11 maps it to `needs_review`, which is also what the record's evidence - 3 supporting + 1 contradicting claim - calls for) and the `hypothesis_evidence` conflict target `(hypothesis_id, claim_id)`, which stopped matching a unique constraint when migration 12 made the key polarity-aware `(hypothesis_id, claim_id, polarity)`. Both are fixed; the seed is idempotent and atomic (one simple-query batch = one implicit transaction), and `tests/seed.test.ts` (10 tests) enforces all of it against throwaway scratch databases. No migration, constraint, or runner change.
