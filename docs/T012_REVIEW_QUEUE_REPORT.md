# T012_REVIEW_QUEUE_REPORT - Unified Review Queue & Operator Workbench

> Date: 2026-10-13. Internal BD tool, local-only. No automated outreach, no send path, no ML,
> no fabricated business facts. The queue is a **view** of existing work, never a second
> source of truth.

## Verdict: PASS

---

## 1. Implemented queue sources

Nine sources, all projected at read time from live domain state. Every source was verified
to exist in the schema before it was wired in; no source is aspirational.

| # | Domain | Types | Domain state it projects | Authoritative workflow (href) |
|---|---|---|---|---|
| 1 | `identity` | `duplicate-candidate` | `match_candidate.status = 'pending'`, both sides canonical | `/resolve` |
| 2 | `evidence` | `claim-disputed`, `claim-expired`, `claim-flagged` | `claim.claim_status='disputed'`, `expires_at < now()`, or `needs_review` | `/evidence/[id]` |
| 3 | `hypothesis` | `hypothesis-review`, `hypothesis-deferred` | `hypothesis.status in ('needs_review','deferred')` | `/hypotheses/[id]` |
| 4 | `proposal` | `proposal-review` | `project_option.status in ('draft','in_review','needs_info')` | `/proposals/[id]` |
| 5 | `brief` | `brief-review` | `brief.status in ('draft','in_review','needs_info')` | `/briefs/[ref]` |
| 6 | `draft` | `draft-blocked`, `draft-review` | `outreach_draft.status in ('draft','in_review')`, blocked when `unverified_points` is set | `/briefs/[ref]` |
| 7 | `catalog` | `catalog-approval` | `capability.status in ('draft','needs_owner_review')` | `/catalog` |
| 8 | `gates` | `gate-unreviewed`, `gate-identity-block` | `hypothesis.status='generated'`; companies with a pending `match_candidate` | `/hypotheses/[id]`, `/resolve` |
| 9 | `stale` | `stale-approved-brief`, `stale-accepted-proposal`, `stale-score` | Approved/accepted artifacts whose basis changed; score runs overtaken by evidence | `/briefs/[ref]`, `/proposals/[id]`, `/scores` |

**Deliberate non-overlap.** `generated` hypotheses appear only under `gates`, never under
`hypothesis`: they are a ranking-gate failure, not a review request. `needs_review` appears
only under `hypothesis`. One underlying issue therefore never produces two rows.

**Deferred hypotheses are informational, not urgent.** A human already parked them. They
are surfaced so the operator can see them, ranked last, and are explicitly not treated as
unresolved work.

## 2. Read-model and query design

`lib/review/queue.ts` exports `getReviewQueue(pool, filters, parts?) -> QueueResult`.

- **No table, no writes.** The queue is a service-layer projection assembled from nine
  bounded parameterized queries. There is no `review_item` table because no durable
  queue-only state is required: every field is derivable, and duplicating it would create
  a reconciliation problem and a second source of truth.
- **Source isolation.** Each source runs inside its own `try/catch`. A failing source is
  appended to `failedSources` and the result is returned with `partial: true` - the page
  still renders, and the operator is told exactly which source is missing. Raw driver
  errors are never surfaced (they can carry SQL text and identifiers).
- **Staleness delegated, not re-derived.** Brief staleness comes from
  `getBriefWorkspace(pool, ref).staleReasons`; proposal staleness from
  `getProposalDetail(pool, id).staleReasons`. The queue therefore cannot drift from the
  owning workflow's own freshness rules. Score staleness mirrors the two documented
  conditions in `rankedOpportunities` (evidence linked after evaluation, claim/hypothesis
  activity after evaluation) and is cross-checked against it in a test.
- **Timestamp serialization at the data layer.** `pg` returns `timestamptz`/`date` as
  `Date` objects, which crash React server components (this bit `/pipeline` twice). A
  single `iso()` helper normalizes every timestamp in the queue to an ISO string, and a
  test asserts it.
- **Bounded.** Per-source `limit 200`; freshness (N+1) checks over the newest 50 approved
  briefs / accepted proposals; page `limit` clamped to `[1, 200]`; `offset` floored at 0.

### Item identity and deduplication

`key = "<domain>:<type>:<recordId>"`, stable across reads and independent of ordering.
Sources are written to be unique by construction; `getReviewQueue` additionally dedupes on
`key` as defence in depth. A test asserts global key uniqueness.

## 3. Priority and tie-breaking rules

Five deterministic categories. **Opportunity score is never an input.**

| Priority | Meaning | Assigned to |
|---|---|---|
| `blocking` | Something downstream cannot proceed until this is decided, or a decided artifact's basis has been invalidated | conflicting-registry identity candidate; company whose identity is unresolved (all its opportunities fail the identity-clear gate); approved brief / accepted proposal flagged stale |
| `high` | A human decision is explicitly waiting | disputed or expired claim; `needs_review` hypothesis; `in_review` proposal; `in_review` brief; draft blocked by unverified assertions; `generated` hypothesis excluded from ranking; stale score |
| `normal` | Real but not blocked | claim flagged for review; `needs_info` proposal; `needs_info` brief; `in_review` draft; catalog entry awaiting the owner |
| `low` | Not yet submitted | `draft` proposal; `draft` brief; unsubmitted outreach draft |
| `informational` | Deliberately parked, not actionable now | `deferred` hypothesis |

Ordering: `priority rank` -> `updatedAt` **ascending** (oldest first, anti-starvation) ->
`key` ascending. All three are total and deterministic; two consecutive reads return
byte-identical ordering (asserted).

A test asserts that every `blocking` item is of an integrity/identity type
(`duplicate-candidate`, `gate-identity-block`, `stale-approved-brief`,
`stale-accepted-proposal`) and that no score `total` ever appears in a queue item.

No urgency, SLA or deadline is invented: only stored `created_at`/`updated_at` are used,
and the UI age column renders `today / N days / N mo / -`.

## 4. UI and API changes

- **UI:** `app/review/page.tsx` is now the unified operator workbench. Previously it listed
  only briefs in review. It renders: a description of what the queue is and is not, a GET
  filter form (domain / priority / company / search, all with `<label for>`), a partial-result
  warning naming the unreadable sources, the inbox table (Priority, Item, Why it is here,
  Age, Workflow) with per-domain deep links, pagination, and a per-domain footer index. All
  states are server-rendered; there is no client JS and no loading state to speak of, which
  is recorded as a limitation rather than dressed up.
- **API:** none added. No new route, no new endpoint, no mutation path. The queue exposes no
  transition of its own - see section 6.

## 5. Search, pagination and stated limits

Search is a **bounded substring match** over item title, item reason and company name,
capped at 200 characters per term. This schema has no full-text index; the page says so in
its own copy. Comprehensive search coverage is explicitly **not** claimed.

Pagination is offset/limit, default 25 per page, hard ceiling 200. `domain` and `priority`
are validated against closed allow-lists (`422 bad_domain` / `422 bad_priority`); `limit`,
`offset`, `company` and `q` are coerced, clamped and length-bounded rather than trusted.

## 6. Authorization, delegation and audit controls

- **No new authentication.** The application remains local-only under the existing
  documented limitation (D-012 / `OPERATOR_API_TOKEN`). No security design was invented.
- **No bypassing domain permissions.** The queue is read-only and holds no privileged
  connection of its own; it uses the same `getPool()` the rest of the app uses, and RLS
  still applies to any other role. The unprivileged `noaccess` role is denied on the
  underlying tables (asserted, SQLSTATE 42501), so an aggregated endpoint cannot become a
  privilege-escalation path.
- **Every action is delegated.** "Open" links to the owning workflow. Reviewing an
  identity candidate, assessing a claim, deciding a hypothesis, proposal, brief or draft,
  approving a catalog entry, and re-evaluating a score all go through the existing domain
  service or API, which keeps its own validation, transition guards and `audit_log` writes.
  The queue duplicates no transition logic - there is none to duplicate.
- **Read-only is proven, not asserted.** A test compares `count(*) FROM audit_log` before
  and after three queue reads and requires equality.
- **Privacy.** Outreach bodies, pipeline notes and operator notes are never loaded into a
  queue item - only brief ref, channel, version and whether unverified points exist. A test
  plants a marker string in a draft body and asserts it never appears in any queue item,
  and that the draft's `href` resolves to its brief. A static guard additionally asserts
  `lib/review/queue.ts` contains no `insert into` / `update` / `delete` and no `fetch(`.
- **No-send boundary unchanged.** Approving a draft still sends nothing; the human sends it.
  The existing repository-wide no-automated-delivery scan in `tests/sales.test.ts` still
  passes and now also covers `lib/review/queue.ts`.

## 7. Stale and reopening semantics

- **Entering / leaving is domain-driven.** An item appears because its record satisfies a
  projection predicate and disappears the moment the domain record changes. There is no
  queue-side "completed" flag and no universal completion state.
- **Decided items stay out.** Accepted / rejected / deferred / archived / superseded /
  withdrawn records are never re-surfaced by the queue. `deferred` is the single exception,
  and only because it is not a decision to close - it is surfaced at `informational`.
- **Reopening is the domain's call.** `reopenCandidate` (T-004) returns a decided candidate
  to pending with a documented reason; the item reappears on the next read. Tested.
  Supersession (T-008) plays the same role for hypotheses: a new material claim supersedes a
  validated hypothesis and creates a fresh `generated` one, which re-enters the queue.
- **Stale never rewrites approval.** An approved brief whose hypothesis was superseded, or
  whose evidence moved, is flagged `stale` and `blocking` while keeping `status: approved`.
  The queue reports the domain helper's own `staleReasons` verbatim; the test asserts the
  queue's `why` contains every reason the brief workspace itself reports.
- **Deleted records cannot orphan the view.** Deleted hypotheses simply stop projecting;
  asserted.

## 8. Known limitations and unsupported actions

1. **No inline actions.** Every item requires a navigation. This is deliberate - the task
   forbids duplicating domain transitions - but it does mean the workbench is one click
   deep, not one click done. Adding a real action would require a queue action endpoint that
   delegates to the domain service; that is deferred, not implemented.
2. **No full-text search**, no faceting by company beyond substring, no saved views, no
   assignment/ownership, no snooze, no bulk operations.
3. **No client-side state.** The page is fully server-rendered; there is no loading
   skeleton because there is no client fetch.
4. **Approval-time freshness only.** Brief and proposal staleness is computed for
   `in_review`/`needs_info`/`approved`/`accepted` rows within a 50-row window; a very large
   backlog beyond that window is reported as "not scanned", not as "fresh".
5. **Catalog source depends on unapproved content.** The catalog queue works, but the
   entries themselves are placeholders pending D-004 / D-005. The queue correctly surfaces
   them as owner decisions rather than as offerings.
6. **No authentication.** Unchanged limitation, inherited from prior tasks.

## 9. Outstanding risks

- **R-01 (cross-file test coupling).** Every suite shares one local database. Test *files*
  now run sequentially (`vitest.config.ts -> fileParallelism: false`) because concurrent
  fixture writes raced other files' global assertions. T-012 fixtures also avoid the
  `registry_id like 'RX-%'` namespace that `tests/resolve.test.ts` cleans up - a collision
  that was observed and fixed, not theorised. New suites must pick a non-colliding prefix.
- **R-02 (stale `db.mjs verify` assertion) — RESOLVED 2026-10-13.** Raised here as a pre-existing
  discrepancy, not a T-012 regression: `db/tests/t002_verify.sql:16` asserted
  `count(*) FROM public.source = 12`, but T-006 added the live connector row `gleif-api`
  (`kind='connector'`) and `20261013000007_source_kinds.sql` documents the invariant as
  *12 categories*. The gate was corrected in a dedicated follow-up
  (`docs/R02_SOURCE_CATEGORY_VERIFICATION_REPORT.md`): it now counts category rows only,
  keeps the connector count as reported evidence, and requires `gleif-api` to be present.
- **R-03 (score weights remain provisional).** The queue deliberately ignores score, so it
  is unaffected, but D-006 stays open until n >= 30 reviewed outcomes exist.
- **R-04 (owner decisions).** D-004 and D-005 keep the catalog source permanently populated
  with owner-decision items until real content lands.

## 10. Exact test, regression, type-check and build results

**New suite - `tests/review.test.ts`: 20/20 passed.**

All nine sources present; stable-key uniqueness; status/priority mapping; full ordering plus
tie-break and byte-identical re-read determinism; score-never-drives-priority; deep-link
routes; draft-body privacy; filters (domain/priority/company/search/miss); bounded pagination
and clamped/NaN/negative input; `422` on unknown domain and priority; 5,000-char search input
bounded to zero results; empty non-error result; identity item leaves on decision and returns
on `reopenCandidate`; accepted candidate merges and hides the merged record; approved brief
flagged stale with approval intact and reasons agreeing with `getBriefWorkspace`; stale score
agreeing with `rankedOpportunities`; ISO-string serialization; audit-log invariance across
reads; partial result naming a failed source without leaking its message; one part per
declared domain; concurrent domain update during reads; deleted underlying rows; `noaccess`
denial on `match_candidate` and `brief`; static no-mutation / no-fetch / no-POST guards.

**Full regression: `npx vitest run` -> 15 files, 222 passed, 1 skipped (opt-in), 0 failed.**
Run twice, identical results. T-002 through T-011 suites unchanged and green
(202 previous tests + 20 new). No assertion was weakened, skipped or removed.

**Type-check:** `npx tsc --noEmit` -> clean, no output.
**Build:** `npm run build` -> clean, all routes compiled including `/review` (`ƒ` dynamic).
**Migrations:** `node scripts/db.mjs migrate` -> `already up to date` (dev and test); no
migration added by T-012 because no schema changed. Container `grayscales-pg` health
`healthy` throughout. Test-DB residue after the run: 0 `T12` rows.
**HTTP round-trip** (`next start` on 127.0.0.1:3101, two smoke companies then removed):
`/review` 200; populated inbox rendered `blocking` identity and gate items with reason text
and `/resolve` deep links; `?domain=`, `?priority=`, `?company=`, `?q=` filters reflected in
the form and the result set; unknown `domain`/`priority` rendered the validation message;
no-match rendered the documented empty state; no `method="post"` anywhere in the page.

## 11. Recommended next task

**T-013 - Outcomes, rejection/failure logs and learning reports**, which is the next
prerequisite-ordered task in `docs/LOW_LEVEL_PLANNING.md`. R-02 no longer needs an owner
decision - it is resolved (`docs/R02_SOURCE_CATEGORY_VERIFICATION_REPORT.md`). D-004, D-005,
D-006 and D-008 remain open and are not resolvable by implementation work. The seed defect
surfaced during R-02 was repaired under R-03 (`docs/R03_SEED_COMPATIBILITY_REPORT.md`).