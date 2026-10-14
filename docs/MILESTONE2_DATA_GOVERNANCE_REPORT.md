# MILESTONE 2 — Data Governance & Workflow Integrity (working report)

> Status: IN PROGRESS (reconnaissance complete, implementation underway).
> AUTH-001 guarantees are preserved throughout: every new endpoint/page uses
> `requireOperatorApi` / `requireOperatorPage`; no client actor trust; no open mode.

## 1. Findings (reconnaissance, before any code change)

Baseline at start: full suite **18 files / 266 passed / 1 skipped** (verified by
execution); Docker `healthy`; migrations up to date; `pg_trgm` 1.6 available.

### Confirmed defects (will fix)

1. **F-M2-1 — Learning reports absent (T-013 incomplete).** `outcome_log`,
   controlled rejection vocabulary, `pipeline_event`, `failure_log`, manual
   recording routes, and brief-workspace outcome display all exist (T-010), but
   FR-025's second half — win/reply rates by segment/source/hypothesis type,
   top rejection reasons, stale-evidence rate — has **no aggregation or
   reporting code anywhere** (`grep` for rate/report/learning: only dashboard
   read queries, no statistics). T-013's expected "basic reports" were never built.
2. **F-M2-2 — No global search.** Only per-list substring filters exist
   (companies `?q=`, review-queue bounded match); no tsvector/pg_trgm
   infrastructure; dashboard lists cap at 500 rows with no total counts. An
   operator cannot find a claim, hypothesis, proposal, or brief by text.
3. **F-M2-3 — Stale post-D-012 string.** `app/agencies/page.tsx` error text
   still asks "Is the Supabase stack running?" (Supabase removed by D-012).

### Investigated and cleared (no defect)

- Brief/proposal detail pages **do** render stale warnings with reasons
  (`app/briefs/[ref]/page.tsx:56-62`, `app/proposals/[id]/page.tsx:49-53`).
- Merge function preserves attribution correctly (conflict/alias guards,
  snapshots stay with loser by design, children repointed, dual audit rows).
- Candidate queue + review queue both exclude merged-away sides.
- Commercial page is honest about D-005 (ranges-or-TBD + warning banner).
- Scores page lists ineligible items with per-gate reasons.

### Provisional policies (documented, NOT implemented — owner input required)

- **D-004 (catalog content):** structure final, content is two
  `needs_owner_review` placeholders. Real service lines need the owner.
- **D-005 (pricing):** estimation baselines + operator-entered ranges work;
  rate cards / margin floors / quote policy need the owner.
- **D-006 (scoring weights):** engine + gates + calibration protocol (n≥30)
  exist; weights stay provisional. No tuning without outcome data.
- **D-008 (retention):** no per-class windows, no deletion jobs; existing
  behavior (operator-initiated snapshot delete, 7-day session-expiry purge in
  AUTH-001) is disclosed, not expanded.

### T-013 / T-014 dependency review

- **T-013** (FR-024/FR-025, prereq T-012 ✓): manual logs + controlled
  rejection vocabulary + pipeline/failure logs + workspace display = DONE
  (T-010). **Missing: basic learning reports.** Schema needs no change
  (all reportable fields exist). After reports land, T-013 can complete.
- **T-014** (AC-001…AC-005, prereq T-001…T-013): requires 20 real researched
  briefs + owner QA + scale decision. Not implementable in this milestone;
  a proposed validation protocol will be written for review instead.

## 2. Agreed scope for this milestone

| # | Work | Basis |
|---|---|---|
| S-1 | Trigram global search (migration + lib + API + page + nav) | §5 explicit instruction |
| S-2 | Learning reports (lib + pipeline-page section + tests) | Closes T-013's missing half |
| S-3 | F-M2-3 string fix | Confirmed defect, trivial |
| S-4 | Cross-workflow integrity regression tests | §4 + §8.10 |
| S-5 | Decision proposals D-004/D-005/D-006/D-008 (docs only) | §2; statuses stay OPEN |
| S-6 | T-013 completion report; T-014 proposed spec (docs only) | §3 |
| S-7 | Full verification gates + HTTP smoke | §8 |

Explicitly OUT: weight tuning (D-006), catalog content approval (D-004),
pricing policy (D-005), retention windows/deletion jobs (D-008), real
20-brief research (T-014 labor), pagination rewrites of existing lists
(volumes don't require it; documented), any new infrastructure, any auth
weakening.

## 3. Implementation results

### S-1 — Global search (F-M2-2 fixed)

- Migration `20261014000003_search_trgm.sql`: `pg_trgm` extension (ships with
  the postgres:17 image) + 6 GIN trigram indexes over company name/domain,
  claim text, hypothesis/proposal titles, brief markdown. Additive, idempotent
  (`if not exists`), applied to dev + test.
- `lib/search/global.ts`: read-only projection, one bounded parameterized
  query per domain. Deterministic ranking documented in code and UI:
  exact → prefix → substring → trigram similarity (>0.18), ties by
  created/id. Totals reported separately from capped rows. Queries 2–200
  chars (422 below); per-domain cap 1–25 (default 10). Merged-away companies
  excluded. No writes, no query logging.
- `GET /api/search` (AUTH-001 guarded) + `/search` page (guarded, empty/error
  states, per-group counts, deep links) + nav item "Global Search".
- `tests/search.test.ts` 6/6: all five domains, exact-before-prefix ordering,
  caps/totals/validation, determinism, hostile-input-as-data, merged exclusion.
- Two test-design errors of mine were caught and fixed during implementation
  (searched text that fixtures never contained; wrong hand-computed ranking
  expectation) — recorded because execution, not review, caught them.

### S-2 — Learning reports (T-013 completed)

- `lib/outcomes/reports.ts`: overview reply/win rates, rates by agency type /
  channel / hypothesis category / contributing source (brief counts once per
  source — documented approximation), top rejection reasons with shares,
  evidence-ledger health. Every rate is `{n, denom, rate, lowData}` with
  `MIN_DENOM = 5` below which the report says "insufficient data" instead of a
  percentage. Zero writes (audit invariance tested). No schema change.
- Surfaced on `/pipeline` as "Learning reports (FR-025)" with an explicit
  no-auto-tuning notice. T-013 marked COMPLETE: `docs/T013_OUTCOMES_LEARNING_REPORT.md`.
- `tests/outcomes.test.ts` 6/6 (one hand-arithmetic error of mine caught:
  web reply n=3, not 4 — the implementation was right).

### S-3 — Stale string (F-M2-3 fixed)

`app/agencies/page.tsx` error text now names Docker PostgreSQL instead of the
removed Supabase stack. Only occurrence; settings-page and code comments
checked and intentionally left (accurate historical notes).

### S-4 — Integrity regression tests

`tests/milestone2_integrity.test.ts` 8/8: full-chain provenance + attribution,
mid-chain merge (repoint + snapshot immutability + no orphans + gate
independence), post-approval staleness without approval rewrite, scoring
409 with no row, queue read-only reflection, draft human-only end to end
(incl. approval-blocked-while-unverified + no-delivery-columns assertion),
hostile claim text stored inert, outcome vocabulary + attribution. One wrong
assertion of mine (overall eligibility after merge) was corrected to assert
gate independence instead.

### S-5 — Decision proposals (docs only, all four stay OPEN)

`docs/MILESTONE2_DECISION_PROPOSALS.md`: per decision — current behavior,
implications, options with trade-offs, recommended default, required owner
approval wording, acceptance tests. Register rows D-004/D-005/D-006/D-008 now
point at the proposals. **No owner approval fabricated; nothing implemented
from unapproved proposals.**

### S-6 — T-013 completion + T-014 proposed spec

- T-013 COMPLETE (report above).
- `docs/T014_VALIDATION_PROTOCOL_PROPOSAL.md`: sample plan, per-brief G1–G6
  gate matrix, reproducibility + link-audit + QA-attestation requirements, MVP
  decision format, approval needed to start. T-014 NOT started.

## 4. Verification gates (actual results)

| # | Gate | Result |
|---|---|---|
| 1 | `node scripts/db.mjs migrate` (dev + test) | `already up to date` (26 applied) |
| 2 | `node scripts/db.mjs seed` twice | `seed ok` ×2 |
| 3 | `node scripts/db.mjs verify` | `verify ok` |
| 4 | Full SQL suite | Same `verify` run (6/6 DO blocks incl. R-02 block 1b) |
| 5 | `npx vitest run` | **21 files, 286 passed, 1 skipped, 0 failed** (20 new tests: 6 search + 6 outcomes + 8 integrity) |
| 6 | `npx tsc --noEmit` | Clean |
| 7 | `npm run build` | `Compiled successfully` (`/search`, `/api/search`, `/pipeline` present) |
| 8 | Docker/PostgreSQL | `healthy` throughout |
| 9 | HTTP smoke (production build, loopback) | anon `/search` → 307 `/login?next=%2Fsearch`; anon `/api/search` → 401; authed `/api/search?q=portal` → 200 with grouped totals; authed `/search` + `/pipeline` (Learning section present) + `/review` → 200; short query → 422 with message |
| 10 | Changed-invariant regressions | seed count 25→26 updated (new migration); all other suites untouched and green |

Residue: test DB 0 fixture rows/sessions; dev seed intact (3 companies, 5 claims,
12 categories, 1 connector); smoke sessions removed (0); no `.tmp`, no stray files;
one pre-existing migration-count bump only. Fresh + migrated paths both covered
(seed.test.ts exercises fresh scratch DBs; dev exercises the migrated path).

## 5. Auth + local-only confirmation (AUTH-001 preserved)

- No guard removed or weakened: handler/gate parity re-verified by script
  (every non-auth API handler calls `requireOperatorApi`; every POST also
  `requireSameOrigin`; all 30 pages call `requireOperatorPage` — the new
  `/search` page and `/api/search` route follow the same pattern).
- `checkOperatorToken` still closed-by-default; `AUTH_DEV_OPEN` untouched and
  unset; no secret in any new code, log, or response (search echoes only the
  query string back; reports carry counts only).
- Smoke re-proved 401s for anonymous search access and 200s with session.
- Local-only intact: loopback DB bindings, loopback-only test URLs, server
  exercised on 127.0.0.1:3101 only, no public ports, no cloud resources.

## 6. Remaining limitations and owner decisions

- D-004/D-005/D-006/D-008: proposals ready, approvals pending. Silence keeps provisionals.
- T-014: spec proposed, labor + approvals + QA assignee pending. Do not begin without owner commitment.
- R-05 QA attestation (human sign-off for AC-003): still outstanding by nature.
- Search ranks by SQL classes + trigram similarity, not linguistic relevance; per-domain caps (default 10); no saved searches.
- Reports need real outcome volume before any rate is meaningful; source attribution approximate (documented).
- Existing 500-row dashboard lists unchanged (volumes don't require pagination; stated, not silently capped — totals still unshown there, accepted limitation).

## Verdict: CONDITIONAL PASS

Implementation is sound and every verification gate passed, but explicit owner
decisions (D-004/D-005/D-006/D-008 approvals, T-014 commitment, R-05 QA
attestation) remain by design. No critical invariant, security guarantee, or
gate failed. Do not begin Milestone 3; awaiting review.
