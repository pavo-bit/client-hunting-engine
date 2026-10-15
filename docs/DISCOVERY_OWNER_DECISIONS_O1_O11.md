# DISCOVERY OWNER DECISION REGISTER — O1–O11

> Established 2026-10-14 under Prompt 2 (no prior O-register existed — verified
> by search; these identities are new, not preserved). Every entry is OPEN
> unless a dated owner reply is recorded here. Nothing below approves itself.

| ID | Question | Status | Existing evidence | Impact if unresolved | Blocks | Options + recommendation | Explicit approval required |
|---|---|---|---|---|---|---|---|
| O1 | Does the direct-client pipeline exist in scope (vs D-001 agencies-only)? | OPEN | D-001 locks agencies w/ explicit-D-*-only expansion; zero direct-client artifacts in code/schema | Pipeline schema, taxonomy, scoring fit, briefs, reports cannot be designed | Implementation of any direct-client work | (a) Agencies-only (recommend default: matches all verified code) / (b) Approve direct-client scope with segment definition | Dated reply: "(a) agencies-only confirmed" or "(b) direct-client scope approved with <segment definition>" |
| O2 | Is the 25/25 pipeline allocation approved (or an alternative)? | OPEN | Proposed only; no counter/tally code exists | Tallies, shortfall rules, UI cannot be finalized | Allocation logic + reporting | (a) Approve 25/25 / (b) Approve alternative split / (c) No fixed split, report raw counts (recommended until data exists) | Dated reply naming the split or (c) |
| O3 | Are the §4A counting measures + the 50-target basis accepted? | OPEN | Amendment §4A defines measures; engine reports found/new/duplicates today | The 50-target stays unmeasurable; progress claims stay unverifiable | Promoted-runs reporting, acceptance of any refresh | (a) Accept measures as defined (recommended) / (b) Amend definitions | Dated reply: "counting measures accepted" |
| O4 | Coverage-planner scope: task lists, low-yield N, concentration caps, under-explored share? | OPEN | Engine bounds exist (25×3, 120 s); no planner | Runs stay single-query; stopping rules stay implicit | Planner implementation | (a) Approve PROPOSAL defaults (N=3, caps) / (b) Set values / (c) Defer planner, keep single-query runs (recommended near-term) | Dated reply with values or (c) |
| O5 | Custom catalog additions: who reviews, what bar, what SLA? | OPEN | D-004 OPEN; status workflow exists (`needs_owner_review`) | Custom lines pile up unreviewed | Catalog depth for proposals | (a) Owner reviews within 2 weeks of proposal (recommended) / (b) Named delegate | Dated reply + reviewer name |
| O6 | Manual pricing bands/policy for discovered opportunities? | OPEN | D-005 OPEN; ranges-with-assumptions provisional | Commercial cases stay ranges-or-absent | Quote-like content | (a) Formalize provisional ranges policy (recommended) / (b) Supply rate card | Dated reply |
| O7 | Are score_v1 weights authorized for Discovery ranking use? | OPEN | D-006 OPEN; weights provisional; calibration needs n≥30 | Ranking use of scores stays provisional-only | Any weight/band/gate change | (a) Keep provisional, ranking as ordering hint (recommended) / (b) Authorize specific values with evidence | Dated reply; (b) requires frozen-score evidence |
| O8 | Retention windows for discovery records/observations? | OPEN | D-008 OPEN; no jobs exist | Records accumulate unbounded; no purge permitted | Any deletion automation | Defer to D-008 (recommended): same windows decision covers discovery classes | Dated reply via D-008 |
| O9 | Which adapters beyond GLEIF, in what order (D-003)? | OPEN | D-003 PROPOSAL priority exists; 1 live adapter | Discovery breadth stays GLEIF + manual | Each new live adapter | Per-adapter: terms verified + decision entry (recommended process) | Dated per-adapter replies |
| O10 | Pipeline eligibility criteria: what counts as eligible per pipeline? | OPEN | Scoring hard gates exist downstream; no discovery-side eligibility screen | 50-target cannot be judged; briefs lack entry criteria | Eligibility screen + brief entry rules | (a) Adopt: identity-resolved + ≥1 corroborated-or-2-observed support + no open contradiction + solution-status ≠ present_confirmed (recommended) / (b) Amend | Dated reply |
| O11 | Pilot thresholds + ground-truth independence + QA assignee (T-014/R-05)? | OPEN | T-014 protocol + template exist; pilot paused | Formal validation cannot start | T-014 sign-off cohort | Grant T-014 §12 (a)–(e) explicitly (no recommendation beyond the protocol) | Five dated approvals |

## Cross-reference to D-register

O5→D-004, O6→D-005, O7→D-006, O8→D-008 (these O-items track the Discovery
surface of the same underlying owner questions; approving the D-item with
Discovery scope noted closes both). O1/O2/O3/O4/O9/O10/O11 are
Discovery-specific and have no D-counterpart.

## Addendum 2026-10-15 (completion gate)

No O-item changed status. Verification found two things the owner should know
before deciding:

- **O10 is the critical path.** With eligibility content unimplemented, every
  opportunity lands as `observed` and `new_eligible` is legitimately `0`. The
  product target of "≥ 50 genuinely new **eligible** opportunities per manual
  refresh" therefore **cannot be judged at all** until O10 is decided — not
  because the mechanism is missing (a refresh can carry 25 tasks × 3 pages ×
  25 records, with no cap anywhere) but because nothing classifies.
- **O7 / D-006 gates any Phase-2 weighting.** Discovery ships no scoring
  weight; any ranking Phase 2 introduces must stay explicitly provisional until
  O7 authorizes specific values with evidence.

**B-D13 (new, 2026-10-15)** — service-identity policy for bearer credentials.
Verified: through the HTTP routes the actor is always the authenticated
session operator, and a body-supplied `actor` cannot reach the database
(executed test `discovery_routes_security.test.ts` R6). What remains undefined
is what identity a *machine* credential should claim in an audit trail. That is
a policy decision and was deliberately not invented. It does not block Phase 2
planning; it blocks audit-grade claims about machine callers.
