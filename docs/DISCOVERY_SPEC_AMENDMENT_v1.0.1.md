# Discovery Specification Amendment v1.0.1

> Focused amendment (not a rewrite). Base: the Discovery brief text plus
> in-repo canonical docs — the referenced `Grayscales_Discovery_Specification_v1.docx`
> was verified absent twice (D0 + D1), so there is no v1.0 file to diff against;
> this document stands versioned on its own. Precedence (§3 of the commission):
> (1) explicitly approved user decisions = §2 below; (2) decided spec items;
> (3) verified repository facts; (4) PROPOSAL-labeled defaults; (5) open owner
> decisions, which stay open. No proposal below is silently approved.

## Change log (v1.0.1)

| # | Change | Basis |
|---|---|---|
| 1 | Per-refresh counting measures defined (§4A); only new eligible count toward 50 | Brief §2 + D0 gap P1 |
| 2 | Pipeline separation kept as architectural rule; direct-client SCOPE stays an owner decision (§4B, O1) | Brief §2 vs D-001 conflict — reconciled without guessing |
| 3 | 25/25 allocation marked PROPOSED-unapproved with shortfall rules (§4B, O2) | Brief §4B instruction |
| 4 | Coverage/stopping-rule semantics defined (§4C) | Brief §4C instruction; engine bounds unchanged |
| 5 | Evidence/eligibility clarifications incl. existing-solution-check states + policy-version snapshots (§4D) | Brief §4D instruction |
| 6 | Identity/opportunity resolution rules restated + extended (relationships, opportunity keys, reposts) (§4E) | Brief §4E instruction; existing merge rules unchanged |
| 7 | Source/security controls specified; DB `enabled`-flag wiring required (§4F) | Brief §4F instruction; D0 gap P2 |
| 8 | Retention classes separated; deletion↔audit rules (§4G) | Brief §4G instruction; D-008 still open |
| 9 | Testable acceptance criteria without invented thresholds (§4H) | Brief §4H instruction |

## §2 requirements preserved (precedence 1 — approved user decisions)

Local-only single operator; manual refresh only; ≥50 genuinely new eligible
opportunities per refresh when available; no total cap; complete history +
collection visibility; agency/direct pipelines separate **as architecture**;
permitted sources/methods only; Reddit + YouTube excluded; attributable
evidence with uncertainty/freshness/contradictions; hybrid catalog with
reviewed custom additions; manual pricing; explainable scoring with
unauthorized weights; human proposal/draft approval; manual outreach; no
LLM/ML scoring expansion; no EIP/VaultForge; no public deploy/cloud spend;
formal pilot paused pending T-014 + approvals.

## §4A. Opportunity counting (normative definitions)

- **new_eligible_committed**: records first created by this run that pass the
  run's eligibility screen. The ONLY measure counting toward the 50-target.
- **promoted_to_eligible**: pre-existing records whose status changed to
  eligible because of this run's evidence/review. Reported separately; never
  counted toward the 50-target.
- **new_evidence_on_existing**: existing opportunities gaining observations.
  Reported as evidence yield, not opportunity yield.
- **duplicate_observations / duplicate_opportunities**: re-seen source
  records (existing `duplicate` outcome) vs distinct records resolving to an
  already-known canonical entity. Reported separately.
- **exploratory / excluded / stale / unresolved**: out-of-scope-but-recorded,
  rule-excluded, expired-basis, and pending-review records respectively.
  Reported with reasons; excluded items carry the excluding rule ID.
- A run report MUST show all six numbers. Claiming the 50-target on any
  other measure is a protocol violation.

## §4B. Pipeline allocation (PROPOSAL — O2; scope O1)

- Agency-partner and direct-client pipelines are separate namespaces end to
  end (records, counts, queues, reports). Shared code (adapters, gates) MUST
  NOT share tallies.
- The 25/25 split is PROPOSED and unapproved. Until approved, report per-
  pipeline counts with no transfer: a shortfall in one pipeline is reported
  as shortfall, and **silent transfer between targets is forbidden** (a
  transfer, if ever approved, would require its own dated decision + audit).
- Direct-client pipeline SCOPE itself is O1-open (conflicts D-001): no
  direct-client schema, collection, or counting may be built under this
  amendment.

## §4C. Coverage and stopping rules

- **Wall-clock limit**: existing 120 s run timeout stands (engine bound).
- **Coverage-task limit**: PROPOSAL — a planned task list per refresh
  (adapter × query × pages); the run stops when tasks exhaust (source
  exhaustion) or bounds hit. Task lists are recorded on the run.
- **Retries**: bounded with backoff for rate-limit/network classes only;
  terms/auth/injection-suspect outcomes never retry (existing behavior).
- **Consecutive low-yield tasks**: PROPOSAL — after N tasks yielding zero
  new_eligible (N owner-settable, default PROPOSAL 3), the run may stop early
  with reason `low_yield_stop`, recorded — never silently.
- **Market concentration**: PROPOSAL — caps per single source/segment per
  refresh to prevent one directory dominating; recorded when triggered.
- **Under-explored allocation**: PROPOSAL — reserve a share of tasks for
  sources with no prior coverage; tracked per source.
- Run end states MUST distinguish: `exhausted` (tasks done), `time_stop`,
  `rate_limited`, `safety_stop`, `partial` (adapter failure mid-run),
  `incomplete_coverage` (stopped with tasks remaining). **Never claim global
  completeness from a count.**

## §4D. Evidence and eligibility

- Source reliability (A–D, about the origin) vs claim status
  (observed/corroborated/inferred/assumed/…) are distinct fields — restated,
  unchanged.
- Claim-level provenance: every material claim links ≥1 observation with
  URL + timestamp; supporting observations required for validation-grade use.
- Independent corroboration: ≥2 distinct (source, origin-host) pairs —
  restated from the T-007 rule, unchanged.
- Freshness: expiry horizons per claim; expired basis = stale handling, not
  silent use — restated, unchanged.
- Contradictions: linked with polarity, surfaced, never suppressed; open
  contradictions block validation — restated, unchanged.
- **Existing-solution-check states (new requirement):** each opportunity
  carries `solution_status ∈ {unknown, absent_evidence, present_confirmed,
  present_unverified}` recording whether the prospect visibly already has the
  proposed solution. `present_confirmed` excludes eligibility with reason;
  the other states route to evidence rules, never to assumption.
- Deterministic re-evaluation: new material evidence supersedes decided rows
  with history preserved — restated, unchanged.
- **Policy-version snapshots (new requirement):** brief freeze records the
  active D-* policy versions + score/rule versions alongside inputs, so a
  brief is reproducible against the rules that produced it.
- Eligibility explanations: every ineligible record carries the failing
  gate/rule IDs (scoring gates already do this; discovery eligibility MUST
  do the same when built).

## §4E. Identity and opportunity resolution

- Automatic merges: **only** deterministic conflict-free rules (existing:
  domain-exact minus shared hosts, older wins) — restated, unchanged.
- Ambiguous matches → human review queue with accept/reject/defer + reason —
  restated, unchanged. **Never merge businesses on name similarity alone.**
- **Business relationships (new):** parent/subsidiary/alias-network links are
  recorded as typed relationship rows for reviewer visibility; they MUST NOT
  trigger merges and MUST NOT share tallies.
- **Opportunity-key canonicalization (new requirement):** stable per-pipeline
  opportunity keys (source + record + normalized identity) so reposts and
  cross-run sightings resolve deterministically.
- **Repost handling (new):** re-seen identical postings resolve to the same
  opportunity key (duplicate_observations), never new rows.
- **Collision management:** same key from conflicting sources → human review
  with both provenances preserved.
- **Idempotency:** existing `(run_id, source_record_id)` + canonical uniques
  stand; reruns MUST remain safe (tested behavior, do not regress).

## §4F. Source and security controls

- Permission-aware collection: adapter manifests declare access requirements;
  collection beyond manifest terms is forbidden.
- Approved methods only: official APIs/exports/pages within terms; LinkedIn
  and restricted social = manual-notes-only (existing policy).
- Safe fetching: SSRF denylist guard mandatory pre-request (existing);
  redirects followed only within allowlisted schemes/hosts policy (PROPOSAL
  default: same-registrable-domain or explicit allowlist).
- Timeouts (existing per-call + run budgets), payload limits (PROPOSAL:
  bounded snapshot excerpts, oversized payloads quarantined with cause),
  rate limits honored per adapter with backoff.
- Manual-research provenance: actor + URL + observed-at on every observation
  (existing manual-entry path).
- **Required wiring:** the DB `source.enabled` flag MUST gate runs, or the
  code registry MUST be documented as the sole gate — one of the two, not
  neither (D0 gap P2; implementation task, not this document).

## §4G. Retention

- Separate policies for: raw observations/snapshots, assessed claims and
  evidence links, business profiles, proposals/briefs, outcomes, operational
  records (runs, sessions, logs), audit history. Values pending D-008 —
  no windows invented here.
- Unresolved periods (pending review, deferred, disputed) stay OPEN across
  any retention boundary; retention MUST NOT auto-resolve work.
- Deletion↔audit: append-only audit rows are never deleted by any retention
  rule; snapshot/observation deletion (explicit, reviewed) preserves the
  claim's provenance stub (source, URL, hash, timestamps) so chains stay
  traversable. No automated deletion jobs until D-008 approves them.

## §4H. Validation (testable acceptance, no invented thresholds)

- Counting measures (§4A) reported per run with definitions attached.
- Pipeline tallies separate with shortfall rules (§4B).
- Run end-state vocabulary (§4C) asserted in tests.
- Eligibility explanations present on every excluded record (§4D).
- Merge/relationship/key/repost rules covered by deterministic tests (§4E).
- Permission/fetch/timeout/payload behaviors covered by contract tests (§4F).
- Retention classes present; no auto-deletion without approval (§4G).
- Formal pilot stays BLOCKED until T-014 + required approvals + independent
  ground truth + approved thresholds are complete. R-05 stays open until its
  exact criteria are verified in repository documentation or explicitly approved.
