# OWNER DECISION PACKET — Business Rules Approval (consolidated, decision-ready)

> **Date:** 2026-10-15 (Master Prompt 1 — decision-resolution phase).
> **Status of this document:** PROPOSED packet content. Nothing here approves
> itself: every item is OPEN until a dated owner reply is recorded in the
> canonical registers (`docs/DISCOVERY_OWNER_DECISIONS_O1_O11.md` for O-items,
> `docs/DECISIONS_AND_OPEN_QUESTIONS.md` for D-items). An empty approval
> section (§9) awaits the owner's hand — no dates, names or signatures are
> filled in.
>
> **What changed vs the Part 1 packet:** same path, extended scope. The Part 1
> items are preserved verbatim in meaning; Workstream C proposals (catalog,
> pricing, scoring, retention/privacy, evaluation, pilot) are added as
> decision-ready options with evidence, uncertainty and trade-offs; a
> traceability matrix, closure tests and a status-separated approval section
> are added. No business rule was activated to produce this document.

## 1. Executive summary

The platform is structurally complete and verified (53 files / 541 passing
tests per the last full run — a historical claim, see §2), but every
business-rule gate that would let it qualify leads, publish policy, or start
a pilot is OPEN. This packet resolves the blockers into 19 decision items,
each with exact wording, options, an evidence-based recommendation (explicitly
not an approval), trade-offs, dependencies, required evidence and an objective
closure test. The critical path is O10 (eligibility criteria): without it,
`new_eligible` is 0 by design, no qualification verdict may be recorded, and
the "≥50 eligible per refresh" target cannot be judged at all. No policy was
activated, no outreach occurred, and nothing was committed, pushed or deployed
to produce this packet (documentation-only phase).

## 2. Current-state findings (verified 2026-10-15)

| # | Fact | How verified | Status |
|---|---|---|---|
| F-1 | Zero active policy/catalog/rubric/capacity versions exist | Read-only query on `p2.reference_version` (dev): zero rows with `status='active'` | VERIFIED FACT |
| F-2 | Dev data holds 8 companies, 5 opportunities, 0 cases | Read-only counts (dev) | VERIFIED FACT |
| F-3 | Git HEAD untouched (`54fa1da`), no commit/push/deploy in this phase | `git log`, `git status` | VERIFIED FACT |
| F-4 | All O1–O11 read OPEN; D-004/005/006/008 read OPEN; T-014 NOT STARTED | Register reads (see §3) | VERIFIED FACT |
| F-5 | No canonical conflicts: O-definitions, O7→D-006 mapping and R-05 references agree across all registers and reports | Cross-document search (see §6) | VERIFIED FACT (no conflicts found) |
| F-6 | Approval-ready records for D-004/005/006/008 exist with PENDING (unsigned) blocks | `docs/D004_D005_D006_D008_DECISION_RECORDS.md` read | VERIFIED FACT |
| F-7 | The assess path refuses without an active policy (409, executed proof) | Prior gate evidence + code path intact (not re-run — stated, not claimed) | INFERRED (code unchanged; re-verify on next suite run) |
| F-8 | Required approver is a role, not a named individual | No named owner/principal in any register (searched) | VERIFIED FACT (absence documented) |

## 3. Canonical decision matrix

Status vocabulary (never merged): Proposed · Awaiting owner decision ·
Approved · Implemented · Independently verified · Blocked · Rejected.

| Canonical ID | Decision / blocker (existing title) | Current status (as recorded) | Business question | Options | Recommendation (not approval) | Trade-offs | Dependencies | Required approver | Evidence required | Closure test |
|---|---|---|---|---|---|---|---|---|---|---|
| D-001 | Target customer segment | Approved → Implemented → Verified (DECIDED 2026-10-12) | — (closed) | — | — | — | — | — | — | already closed |
| D-003 | Source priority + MVP adapter set | Awaiting owner decision (OPEN, proposal exists) | Which adapters beyond GLEIF, in what order? | (a) approve proposed S-05/S-01/S-08 order; (b) amend order; (c) GLEIF-only indefinitely | (a) — matches the 12-category registry and the fixture coverage | (a) breadth sooner, terms-review cost per adapter; (c) zero effort, narrow population | Terms verification per adapter | Owner (unnamed — no individual on record) | Per-adapter terms note + register entry | Register row dated; adapter registered in `production.ts` only after |
| D-004 | Capability catalog content | Awaiting owner decision (OPEN, proposal + approval-ready record PENDING signature) | Which services may proposals/briefs claim? | (A) owner supplies list; (B) adopt starter taxonomy, every line `needs_owner_review` until confirmed; (C) placeholders indefinitely — see `docs/MILESTONE2_DECISION_PROPOSALS.md#d-004` | (B) — starts work without anchoring unconfirmed lines as sold | (A) most accurate, slowest; (B) fast, anchoring risk (mitigated: unconfirmed lines keep all guards); (C) zero effort, catalog features stay stubbed | None (blocks: D-005 pricing attachment, brief depth) | Owner (unnamed) | Signed D-004 record (existing approval block) | Register D-004 dated; `capability` rows flipped from placeholder only after |
| D-005 | Pricing/cost assumptions | Awaiting owner decision (OPEN, proposal + approval-ready record PENDING signature) | Ranges-with-assumptions now, or rate card later, with what floor? | Formalize ranges-with-assumptions (recommended) vs supply rate card vs manual-quote-only | Ranges-with-assumptions — commercial cases stay possible without promising fixed prices | Fixed card: quotable but commits numbers prematurely; manual-only: safest, thinnest briefs | D-004 (prices attach to services) | Owner (unnamed) | Signed D-005 record | Register D-005 dated; briefs show approved form only |
| D-006 | Scoring weights/thresholds/gates | Awaiting owner decision (OPEN, proposal + approval-ready record PENDING signature) | Keep provisional weights until n=30, or authorize values now? | Keep provisional (recommended) vs authorize specific values with frozen-score evidence | Provisional — scores stay ordering hints, never verdicts | Authorizing now: rankable output sooner, unjustified precision risk | n=30 calibration evidence (T-011) for option (b) | Owner (unnamed) | Signed D-006 record (+ frozen-score evidence for (b)) | Register D-006 dated; weights change only after |
| D-008 | Snapshot retention windows | Awaiting owner decision (OPEN, proposal + approval-ready record PENDING signature) | Per-class windows + legal review; when may anything be deleted? | Adopt per-class windows (recommended) vs owner-supplied schedule vs indefinite retention | Per-class windows — bounded growth with audit-safe deletion | Indefinite: simplest, unbounded growth + takedown risk; custom: precise, legal-review cost | Legal review (TBD — no legal conclusion in repo) | Owner (unnamed) | Signed D-008 record | Register D-008 dated; no deletion job until then |
| O1 | Direct-client pipeline scope | Awaiting owner decision (OPEN) | Agencies-only (D-001) vs direct-client with segment definition? | (a) agencies-only confirmed (recommended — matches all verified code); (b) direct scope + definition | (a) | (b) doubles taxonomy/scoring/brief surface for unknown return | D-001 interpretation | Owner (unnamed) | Dated reply naming (a) or (b)+definition | `direct_client` 409 lifted only after (b) |
| O2 | Pipeline allocation | Awaiting owner decision (OPEN) | Fixed split (25/25?) or raw counts? | (a) 25/25; (b) alternative; (c) no fixed split (recommended) | (c) until data exists | Fixed split: targetable, arbitrary before data | O3 basis | Owner (unnamed) | Dated reply | Allocation logic only after |
| O3 | Counting measures + 50-target basis | Awaiting owner decision (OPEN) | Accept §4A measures as defined or amend? | (a) accept (recommended); (b) amend | (a) | (b) restarts measurement design | None | Owner (unnamed) | Dated reply | Target judged only after |
| O4 | Coverage-planner scope/values | Awaiting owner decision (OPEN) | Approve N=3/caps, set values, or defer? | (a) approve; (b) set; (c) defer (recommended near-term) | (c) — thresholds already caller-stated | Planner: richer runs, new semantics to validate | None | Owner (unnamed) | Dated reply with values or (c) | Planner built only after (a)/(b) |
| O5 | Catalog review SLA | Awaiting owner decision (OPEN) | Who reviews custom lines, what bar, what SLA? | (a) owner reviews within 2 weeks (recommended); (b) named delegate | (a) | (b) faster, needs a name that does not exist yet | D-004 | Owner (unnamed) | Dated reply + reviewer name | Queue drains only after |
| O6 | Pricing bands | Awaiting owner decision (OPEN) | Formalize provisional ranges or supply rate card? | (a) formalize provisional (recommended); (b) rate card | (a) | Same as D-005 | D-004, D-005 | Owner (unnamed) | Dated reply | Quote-like content only after |
| O7 | score_v1 weights for Discovery ranking | Awaiting owner decision (OPEN) | Provisional hints or authorized values? | (a) provisional (recommended); (b) authorize with evidence | (a) | Same as D-006 | D-006, frozen-score evidence for (b) | Owner (unnamed) | Dated reply (+ evidence for (b)) | Ranking use only after |
| O8 | Discovery retention windows | Awaiting owner decision (OPEN) | Defer to D-008 (recommended) | Defer to D-008 | Defer — one windows decision covers discovery classes | Split decisions could contradict | D-008 | Owner (unnamed) | Via D-008 | Same as D-008 |
| O9 | Adapters beyond GLEIF | Awaiting owner decision (OPEN) | Which adapters, what order? | Per-adapter terms + register entry (recommended process) | Process over outcome: no bulk approval | Bulk: fast, terms risk per source | D-003 | Owner (unnamed) | Dated per-adapter replies | One adapter at a time |
| O10 | Pipeline eligibility criteria | Awaiting owner decision (OPEN) — CRITICAL PATH | What counts as eligible per pipeline? | (a) adopt recommended screen (identity-resolved + ≥1 corroborated-or-2-observed + no open contradiction + solution ≠ present_confirmed); (b) amend | (a) — matches the built evidence model | (b) restarts screen design; delay blocks everything below | None (blocks: verdicts, 50-target, briefs entry) | Owner (unnamed) | Dated reply | Eligibility content only after |
| O11 | Pilot thresholds + ground truth + QA assignee | Awaiting owner decision (OPEN) | Grant T-014 §12(a)–(e) explicitly? | Grant explicitly (no recommendation beyond the protocol) | None offered — protocol stands as written | Skipping: validation without ground truth is theater | T-014 protocol (exists), R-05 | Owner (unnamed) | Five dated approvals | T-014 starts only after |
| T-014 | Validation protocol execution | Blocked (NOT STARTED, guarded by test) | — (execution, not a question) | — | — | — | O11 (all five), R-05, B-D1 | Owner (unnamed) | Approvals above | Section 12 sign-off cohort only after |
| R-05 | QA attestation + criteria | Awaiting owner decision (OPEN per readiness reports) | Who attests, against what criteria? | Owner attests or names QA + criteria | Name attestor + freeze criteria list | Vague criteria: attestation without content | Acceptance criteria list (T-014 G1-G6 + eval thresholds) | Owner (unnamed) | Dated attestation | Pilot/production claims only after |
| B-D1 | Canonical `.docx` absent | Blocked (file absent; brief+repo unconfirmed) | Supply file or confirm brief+repo canonical? | (a) supply; (b) written confirmation (recommended — zero cost) | (b) | (a) may restart spec work | None | Owner (unnamed) | File or written confirmation | Spec-compliance claims only after |
| B-D13 | Service-identity policy | Awaiting owner decision (OPEN, raised Part 1) | Named service identities, operator identity, or no machine access? | (a) named per-credential identities (recommended, to be designed); (b) operator identity; (c) no machine access | (a) — audit-grade trails need named actors | (b) conflates human/machine; (c) simplest, blocks automation later | None (blocks: machine-caller audit claims) | Owner (unnamed) | Dated policy choice | Machine paths attributed only after |
| F18 | Frozen run-event counters | Awaiting owner decision (advisory, OPEN) | Snapshot per run or live-projection stands? | Stand as is (recommended) | Stand — ledger + eligibility history answer intent | Snapshots: audit-grade run figures, new rows + retention cost | D-008 (retention for new rows) | Owner (unnamed) | Evidence of a consumer need | New snapshot rows only after |

## 4. Decision options and recommendations — Workstream C domains

### 4.1 Service catalog and eligibility (D-004, O1, O10; O5 supporting)
- **Observed fact:** `public.capability` holds 2 placeholder rows (`needs_owner_review`); scoring grants unapproved entries +0; briefs disclose; review surfaces them. Structure final and tested. Phase 2 service definitions exist only as draft/blocked fixtures in tests; production catalog versions: none.
- **Evidence:** seed + code paths (intake → brief disclosure), O-register wording, D-004 proposal options A/B/C.
- **Uncertainty:** the agency's real sellable list, delivery capacity and commercial commitments are unknown to the repo — nothing here fills them in.
- **Recommendation:** D-004 option B (starter taxonomy, every line unconfirmed until written confirmation); O1(a) agencies-only; O10(a) recommended screen; O5(a) 2-week review.
- **Risk:** anchoring on unsold lines (mitigated: guards stay until per-line confirmation); agencies-only may miss direct-client value (unknown size — unmeasured).
- **Still required:** signed D-004 record; dated O1/O10/O5 replies; per-line confirmations (name + entry criteria + owner each).
- **Pipelines:** agency-partner only until O1(b); `direct_client` 409 stays. Evidence bar for a legitimate opportunity: the O10 screen once approved; until then, observed-only rows are inventory, not leads.

### 4.2 Pricing (D-005, O6)
- **Observed fact:** briefs carry `cost_low/high + assumptions` (ranges-with-assumptions provisional); no rate card exists anywhere in the repo.
- **Evidence:** seed project row (8000–15000 USD + stated assumptions), D-005 proposal.
- **Uncertainty:** real prices, margins, capacity costs — unknown; this packet invents none.
- **Recommendation:** formalize ranges-with-assumptions (assumptions + currency + scope limits mandatory; human review mandatory before any client-facing figure; unapproved estimates render as "provisional — unconfirmed", never as confirmed prices).
- **Risk:** ranges may anchor negotiations (mitigated: assumption-first presentation, human-send-only rule already enforced by schema).
- **Still required:** signed D-005 record; dated O6 reply.

### 4.3 Deterministic scoring (D-006, O7, O3-gating)
- **Observed fact:** provisional scorecard (Fit 24 + Evid 15 + Opp 14 + Feas 10 + Timing 6 − deductions; v0.1-PROVISIONAL; seed total 64/B); T-011 engine implemented with provisional weights; scores never override gates (QUALITY_GATES G2, enforced in code); Phase 2 engine runs on versioned fixture policies only, production versions: none.
- **Evidence:** scoring model doc, T011 reports, eval harness with pre-declared thresholds.
- **Uncertainty:** whether provisional weights rank well in the wild (n<30 calibration; real-world precision unmeasured by design so far).
- **Recommendation (proposed owner decision, NOT activated):** keep provisional until n=30 frozen-score evidence; rubric = the six-dimension model with floors before composites, lexicographic order, tie-breaks (evidence_confidence → need_strength → id), missing→null with coverage veto, bands only when published, timing decay per signal family; approved positives = corroborated/observed support + registry identity; negatives = contradictions, stale-only evidence, single-source, present_confirmed solution; missing/ambiguous/conflicting handled as unscored (never defaulted, never probable); observations vs hypotheses separated at the claim/hypothesis tables; every score cites evidence ids + versions + as_of.
- **Risk:** provisional weights may misrank (mitigated: ordering-hint labeling, floors, no gate override); authorizing early bakes in unjustified precision.
- **Still required:** signed D-006 record (+ frozen-score evidence for any authorization beyond provisional); dated O7 reply; dated O3 reply for the counting basis.

### 4.4 Retention and privacy (D-008, O8)
- **Observed fact:** snapshots immutable with retention classes; claims carry `expires_at`; takedown/opt-out → suppress + tombstone, hash kept unless legally required deletion (human decides); contradictions undeletable (app role lacks DELETE, tested); audit append-only for the app role (owner/superuser limitation honestly documented); NO deletion job exists; NO backup encryption; no off-host custody.
- **Evidence:** data-model doc §§6–8, verifier checks, backup/restore doc §§5–6.
- **Uncertainty:** legal obligations (GDPR/UK-GDPR/PDPA applicability) — the repo flags for human legal review and gives no legal conclusions; this packet invents none.
- **Recommendation:** adopt per-class windows (registry: long; social: platform-policy-bound; pages: owner-set window — NO period invented here, owner fills it) + legal review; until signed: no purge automation, takedowns handled manually case-by-case.
- **Risk:** unbounded growth (mitigated later by windows); premature deletion destroys auditability (mitigated: windows + hash retention + human gate).
- **Still required:** signed D-008 record (with the page-window value filled by the owner); dated O8 reply (or defer-to-D-008 note); legal review (external).

### 4.5 Evaluation protocol (T-014, R-05, O11-evidence)
- **Observed fact:** T-014 protocol (11 elements) + recording template exist; validation NOT STARTED (test-guarded); eval harness with versioned gold v1 (12 synthetic items, dev/heldout split), 4 baselines over identical pools, pre-declared thresholds, generated report; reviewer disagreement + adjudication fields in the format; metrics state denominators; unmeasured metrics named with capture plans.
- **Evidence:** T014 docs, `eval/goldset.v1.json`, generated baseline report, harness code.
- **Uncertainty:** synthetic ≠ commercial outcomes (stated in every artifact); small-n uncertainty (denominators 1–4); no blind review has occurred (0 cases).
- **Recommendation:** adopt the protocol as written; population = accumulated agency-partner opportunities stratified by pipeline/status once O1/O3 land; independent labeling by two reviewers + recorded adjudication; holdout protection via declared splits (never tune on heldout); same-pool baselines; metric/threshold/uncertainty rules as implemented; disagreements and misses become regression fixtures; thresholds re-declared per policy/gold version, never carried silently.
- **Risk:** synthetic-first evidence may not transfer (mitigated: pilot re-run on approved policy with ≥30 blind-reviewed cases before any quality claim).
- **Still required:** O11 five approvals; R-05 attestation + frozen criteria; ≥30-case blind review (count today: 0).

### 4.6 Pilot acceptance (O11, R-05, B-D1, B-D13)
- **Observed fact:** pilot report verdict PILOT BLOCKED with 10 authorization conditions; no outreach mechanism exists in schema (verified by verifier); drafts are human-send-only.
- **Evidence:** pilot report, verifier §3/§6, outreach schema absence.
- **Uncertainty:** none structural — the blockers are decisions, not unknowns.
- **Recommendation:** go/no-go authority = the owner, in writing, only when §8's ten conditions hold; rollback = restore last verified backup into scratch + re-verify (drill already executed); technical reliability already demonstrated (suite/build/verify/backup evidence).
- **Risk:** premature pilot contacts real businesses on unapproved policy (mitigated: BLOCKED verdict stands until all ten hold).
- **Still required:** the ten conditions (§8), each with its artifact.

## 5. Dependencies and unresolved conflicts

- Dependency graph: D-004 → D-005/D-006-content, O5, brief depth; O10 → verdicts, 50-target judgment, brief entry, P2-01+; O1 → direct-client everything; O2/O3 → target judgment; O7/D-006 → non-provisional weighting; O11+T-014+R-05+B-D1 → any pilot/validation; B-D13 → machine-caller audit; F18 → frozen snapshots (advisory); D-008 → retention jobs + F18 rows.
- **Conflicts found: none.** O-definitions agree across the O-register, blocker register and all reports; O7→D-006 mapping is identical everywhere; R-05 references agree (open attestation); T-014 NOT STARTED is consistent between plan doc and test guard. The one apparent tension — D-006 (weights) vs O7 (ranking use) vs Phase 2 fixture weights — is resolved by scope: D-006 governs the Phase 1 scorecard, O7 governs Discovery ranking use, fixture weights govern tests only; production has no active versions of any. No guesswork was needed.

## 6. Evidence requirements and acceptance (closure tests)

Each row of §3 names its evidence and closure test. In general: a dated owner reply (or signed record where an approval block exists: D-004/005/006/008) recorded in the canonical register; implementation only after; tests asserting the new behavior (or the documented absence); the docs guard (`tests/docs_consistency.test.ts`) green — it fails the build on silent approvals, dropped IDs, started T-014, or broken links.

## 7. Pilot blockers (consolidated)

The ten conditions in `docs/PILOT_READINESS_REPORT.md` §5 (O10 policy → D-004 service → O1/O2/O3 scope → O7 weighting → O9/D-003 adapters → O11/T-014/R-05/B-D1 validation → B-D13 machine identity → ≥30 blind-reviewed cases → re-run evaluation). Current count toward them: 0. Verdict stays PILOT BLOCKED.

## 8. Traceability note

Requirements → tests: `docs/GRAYSCALES_DISCOVERY_TEST_TRACEABILITY.md` (§§1–8, Part 3 rows included). Decisions → closures: the §3 matrix above (each row is addressable by its canonical ID). Blocker history: `docs/DISCOVERY_BLOCKERS_AND_TRACEABILITY.md` (B-D1…B-D13, preserved) and `docs/GRAYSCALES_DISCOVERY_FINDINGS_REGISTER.md` (F/P1/P2/P3 series, all closed except the owner-gated F18/F20/F23).

## 9. Owner approval section

> Rules: sign ONLY after reading the cited section. A signature activates NOTHING by itself — implementation follows in a later phase under change control. Leave rows blank until decided. Status per row uses exactly one of: Proposed · Awaiting owner decision · Approved · Implemented · Independently verified · Blocked · Rejected.

| ID | Item | Status | Owner action | Signature / date |
|---|---|---|---|---|
| D-003 | Source priority + MVP adapter set | Awaiting owner decision (Proposed: S-05/S-01/S-08 order) | Reply (a)/(b)/(c) | _ _ |
| D-004 | Capability catalog content | Awaiting owner decision (Proposed: option B; approval block exists, PENDING) | Sign record or reply | _ _ |
| D-005 | Pricing/cost assumptions | Awaiting owner decision (Proposed: ranges-with-assumptions; approval block PENDING) | Sign record or reply | _ _ |
| D-006 | Scoring weights/thresholds/gates | Awaiting owner decision (Proposed: provisional until n=30; approval block PENDING) | Sign record or reply | _ _ |
| D-008 | Snapshot retention windows | Awaiting owner decision (Proposed: per-class + legal review; approval block PENDING) | Sign record (fill page-window value) or reply | _ _ |
| O1 | Direct-client scope | Awaiting owner decision (Proposed: agencies-only) | Dated reply (a)/(b)+definition | _ _ |
| O2 | Pipeline allocation | Awaiting owner decision (Proposed: raw counts) | Dated reply | _ _ |
| O3 | Counting measures + 50-target | Awaiting owner decision (Proposed: accept as defined) | Dated reply | _ _ |
| O4 | Planner scope/values | Awaiting owner decision (Proposed: defer) | Dated reply | _ _ |
| O5 | Catalog review SLA | Awaiting owner decision (Proposed: owner reviews ≤2 weeks) | Dated reply + reviewer name | _ _ |
| O6 | Pricing bands | Awaiting owner decision (Proposed: formalize provisional) | Dated reply | _ _ |
| O7 | score_v1 weights for ranking | Awaiting owner decision (Proposed: provisional) | Dated reply (+ evidence for (b)) | _ _ |
| O8 | Discovery retention | Awaiting owner decision (Proposed: defer to D-008) | Reply via D-008 | _ _ |
| O9 | Adapters beyond GLEIF | Awaiting owner decision (no content proposed — per-adapter process) | Dated per-adapter replies | _ _ |
| O10 | Eligibility criteria | Awaiting owner decision (Proposed: §4.1 screen) | Dated reply | _ _ |
| O11 | Pilot thresholds + ground truth + QA | Awaiting owner decision (protocol stands, no content recommendation) | Five dated approvals | _ _ |
| T-014 | Validation execution | Blocked (NOT STARTED; needs O11+R-05+B-D1) | — (no signature here; §12 cohort on approval) | — |
| R-05 | QA attestation | Awaiting owner decision (attestor + criteria unnamed) | Dated attestation | _ _ |
| B-D1 | Canonical spec | Blocked (file absent) | Supply file or written confirmation | _ _ |
| B-D13 | Service identity | Awaiting owner decision (Proposed: named per-credential) | Dated policy choice | _ _ |
| F18 | Frozen run counters | Awaiting owner decision (advisory; Proposed: stand as is) | Evidence of need, or accept default | _ _ |
| D-001, D-002, D-007, D-011…D-018 (closed) | — | Approved → Implemented → Independently verified (historical) | — (no action) | — |

---

# ADDENDUM — Re-verified baseline audit (2026-10-15, second pass)

> All §1–§9 content above stands unchanged. This addendum records the
> independent re-verification: HEAD `54fa1da`, worktree preserved, zero active
> policy versions, dev 8 companies / 5 opportunities / 0 cases / 0 decisions,
> 44 migrations, `db.mjs verify` ok, loopback-only bindings, gold v1 (12
> items), backup drill green with retention at 4+legacy. No owner reply
> arrived; no approval exists that was not already recorded as OPEN. No
> canonical conflicts found (second search).

## 10. Canonical traceability matrix

Owner column: no named individual exists in any register — every row reads
`Owner (unnamed principal)`; repeating it per row adds nothing, so it is
stated once here. Pilot conditions are the ten from
`docs/PILOT_READINESS_REPORT.md` §5 (C1…C10).

| Canonical ID | Canonical description (faithful summary) | Current status | Evidence | Decision owner | Dependencies (must resolve first) | Pilot conditions affected | Closure criteria | Current blocker | Next action |
|---|---|---|---|---|---|---|---|---|---|
| D-001 | Target customer segment: worldwide software/digital agencies | DECIDED 2026-10-12 | register row | — (closed) | — | — | already closed | none | none |
| D-002 | Geographic scope | DECIDED 2026-10-12 | register row | — (closed) | — | — | already closed | none | none |
| D-003 | Source priority + MVP adapter set | OPEN (proposal exists) | register row + proposal | unnamed | Terms verification per adapter (technical, parallelizable) | C5 | dated per-adapter replies | no owner reply | owner picks order |
| D-004 | Capability catalog content: which service lines are sellable | OPEN (proposal + PENDING record) | register row + proposals doc + approval-ready record | unnamed | None (parallel with O10) | C2 | signed D-004 record | no owner reply/signature | owner signs or replies |
| D-005 | Pricing/cost assumptions | OPEN (proposal + PENDING record) | register row + proposals doc + approval-ready record | unnamed | D-004 (prices attach to services) | — (brief depth) | signed D-005 record | no owner reply/signature; blocked downstream of D-004 | owner signs or replies |
| D-006 | Scoring weights/thresholds/gates | OPEN (proposal + PENDING record) | register row + proposals doc + approval-ready record + T011 | unnamed | n=30 evidence for authorization variant | C4 (via O7) | signed D-006 record (+ evidence for non-provisional) | no owner reply/signature | owner signs or replies |
| D-007 | CSV import limits | DECIDED 2026-10-13 | register row | — (closed) | — | — | already closed | none | none |
| D-008 | Snapshot retention windows | OPEN (proposal + PENDING record) | register row + proposals doc + approval-ready record | unnamed | Legal review (external, TBD) | — (retention jobs) | signed D-008 record with page-window value | no owner reply/signature; no legal input | owner signs + legal review |
| D-009 | (SUPERSEDED by D-012) | historical | register row | — | — | — | — | none | none |
| D-010 | Accessibility standard | PROPOSAL | register row | unnamed | None | none | owner decision | no owner reply | owner decides scope |
| D-011…D-018 (excl. above) | Identity, stack, adapters, evidence, proposals, review, auth | DECIDED (dated) | register rows + tests | — (closed) | — | — | already closed | none | none |
| O1 | Direct-client scope vs agencies-only | OPEN | O-register row | unnamed | D-001 interpretation (closed) | C3 | dated reply (a)/(b)+definition | no owner reply | owner replies |
| O2 | Pipeline allocation | OPEN | O-register row | unnamed | O3 basis (parallelizable) | C3 | dated reply | no owner reply | owner replies |
| O3 | Counting measures + 50-target basis | OPEN | O-register row | unnamed | None | C3 | dated reply | no owner reply | owner replies |
| O4 | Planner scope/values | OPEN | O-register row | unnamed | None | — | dated reply | no owner reply | owner replies |
| O5 | Catalog review SLA | OPEN | O-register row | unnamed | D-004 | — | dated reply + reviewer name | no owner reply | owner replies |
| O6 | Pricing bands | OPEN | O-register row | unnamed | D-004, D-005 | — | dated reply | no owner reply | owner replies |
| O7 | score_v1 weights for ranking | OPEN | O-register row | unnamed | D-006 (+ evidence for (b)) | C4 | dated reply | no owner reply | owner replies |
| O8 | Discovery retention | OPEN | O-register row | unnamed | D-008 (defer) | — | via D-008 | no owner reply | owner replies via D-008 |
| O9 | Adapters beyond GLEIF | OPEN | O-register row | unnamed | D-003 (same question, Discovery surface) | C5 | dated per-adapter replies | no owner reply | owner replies |
| O10 | Eligibility criteria per pipeline | OPEN — CRITICAL PATH | O-register row | unnamed | None (first mover) | C1, C3 (target judgment), brief entry | dated reply | no owner reply | owner replies |
| O11 | Pilot thresholds + ground truth + QA | OPEN | O-register row | unnamed | T-014 protocol (exists), R-05 | C6 | five dated approvals | no owner reply | owner grants |
| T-014 | Validation execution (20-brief + sign-off) | NOT STARTED (test-guarded) | plan doc + guard test | unnamed | O11 (all five), R-05, B-D1 | C6 | §12 cohort sign-off | approvals absent | stop — await approvals |
| R-05 | QA attestation + criteria | OPEN | readiness reports | unnamed | Criteria list (T-014 G1-G6 + thresholds) | C6 | dated attestation | no attestor, no frozen criteria | owner names attestor |
| B-D1 | Canonical `.docx` absent | OPEN | blocker register | unnamed | None | C7 | file or written confirmation | neither supplied | owner supplies/confirms |
| B-D13 | Service-identity policy | OPEN | blocker register | unnamed | None (blocks machine audit only) | C8 | dated policy choice | no owner reply | owner decides |
| F18 | Frozen run counters | OPEN (advisory) | findings register | unnamed | D-008 (if rows built) | — | evidence of need | no consumer need shown | accept default or show need |
| PI-01…PI-10 | Pilot issue ledger (no-policy, no-reviewer, unapproved criteria, no outcome link, multi-active latest-wins, small-n gold, no review timing, GLEIF-only breadth, NULL domains, no off-host DR) | OPEN/DOCUMENTED per ledger | `docs/PILOT_ISSUE_LEDGER.md` | unnamed (PI-04 schema: owner-gated) | Respective owners above | C1–C10 mapped in ledger | Per-ledger retest column | Owner inputs throughout | See ledger |
| C1…C10 | Ten pilot conditions (policy, service, scope, weighting, adapters, validation, spec, identity, reviews, re-run evaluation) | All BLOCKED | `docs/PILOT_DECISION_RECORD.md` | unnamed | §11 dependency graph below | — (they ARE the pilot gate) | Per-condition evidence in decision record | All of the above | Owner authorization sequence |

## 11. Deduplicated dependency graph

Types: **[P]** prerequisite (must resolve first) · **[~]** parallelizable ·
**[T]** technical task (no owner words needed) · **[A]** owner approval ·
**[Z]** pilot authorization condition.

| # | Item | Type | Depends on | Unblocks |
|---|---|---|---|---|
| 1 | O10 eligibility screen | [A] first mover | — | verdicts, 50-target judgment, brief entry, P2-01, assessments in production |
| 2 | D-004 catalog content | [A] (parallel with 1) | — | D-005, O5, O6-content, brief depth, catalog-dependent scoring |
| 3 | D-005 pricing | [A] | 2 | quote-like content |
| 4 | D-006 weights (provisional→authorized) | [A] | n=30 evidence for non-provisional | non-provisional weighting |
| 5 | O7 ranking use | [A] | 4 | Discovery ranking beyond hints |
| 6 | O1 scope | [A] | D-001 reading (closed) | direct-client everything |
| 7 | O2/O3 allocation + basis | [A] (~ each other) | — | target judgment, allocation UI |
| 8 | O4 planner | [A] | — | planner build |
| 9 | D-008 retention (+O8) | [A] | external legal review | purge jobs, F18 rows |
| 10 | O9/D-003 adapters | [A] per adapter | terms verification [T] | breadth |
| 11 | B-D13 service identity | [A] | — | machine-caller audit |
| 12 | R-05 attestation | [A] | frozen criteria (T-014 G1-G6 + thresholds) | validation sign-off |
| 13 | O11 five approvals | [A] | 12 (criteria to attest against) | T-014 start |
| 14 | T-014 execution | [Z] | 13 + B-D1 + ≥30 blind reviews | pilot evidence |
| 15 | B-D1 spec confirmation | [A] | — (owner act only) | spec-compliance claims |
| 16 | F18 snapshots | [A] (advisory) | 9 if built | frozen run figures |
| 17 | Outcome-linkage schema | [A]/[T] | owner scope decision (O11-adjacent) | pursuit/qualified-rate metrics |
| 18 | Reviewer staffing | [A] | named individual(s) | blind review, agreement metrics |

No canonical record establishes a different order; O10-first (remediation
report) is confirmed by impact count (row 1 unblocks the most downstream
items; D-004 is second and parallel, not prerequisite).

## 12. O10 and D-004 deep analysis

### O10 — Pipeline eligibility criteria (canonical: "what counts as eligible per pipeline?", OPEN)
- **Why it blocks downstream:** without an approved screen, `new_eligible`
  stays 0 by design (verified: all 5 dev opportunities `observed`); no
  qualification verdict may be recorded (assess path refuses, 409 — executed
  proof); the "≥50 eligible per refresh" target cannot be judged; briefs lack
  entry criteria (B-D7 stays blocked); Phase 2 P2-01 cannot start.
- **Required owner input:** adopt/amend/supply the screen (identity +
  evidence bar + contradiction handling + solution-status rules); the
  recommendation (a) is in packet §1/§4.1 with trade-offs.
- **If left open:** the platform remains an accumulating inventory with
  honest NULL eligibility — useful storage, not a qualification system. No
  silent default may substitute (the engine has no default gate set by
  construction).
- **Decision question:** "For each pipeline, what exact conditions make an
  opportunity eligible — or confirm the recommended screen as written?"

### D-004 — Capability catalog content (canonical: "Which Grayscales service
lines are sellable in MVP?", OPEN, proposal + PENDING record)
- **Scope effects:** the service list bounds briefs (what can be proposed),
  pricing attachment (D-005 prices attach to lines), review SLA load (O5),
  and Phase 2 service definitions (catalog versions cite approved lines).
  It does NOT bound Discovery (finding is separate from selling) and does
  not require O10 first — parallel track.
- **Required approvals/artifacts:** signed D-004 record (exists, PENDING) +
  per-line written confirmations (name + entry criteria + owner each);
  implementation = flip `capability` rows from placeholder (no migration —
  data change under change control, only after signature).
- **Decision questions:** (1) adopt starter taxonomy as-is, amend it, or
  supply the list from scratch? (2) who confirms each line and by when (O5)?

## 13. Prohibited actions (explicit — this phase and until cited approvals land)

No policy activation/publication · no pilot operations or assessments in
production · no outreach or lead contact · no deployment/cloud/spend · no
commits/pushes · no destructive DB resets · no invented prices, weights,
thresholds, approvers, signatures or dates · no silent approval-by-default ·
no weakened guards/tests · no global lead caps, no fabricated records ·
no pipeline mixing · no unapproved-source use · no suppression override ·
no Discovery writes outside authorized interfaces · no ML scoring, no
schedulers, no Supabase return.
