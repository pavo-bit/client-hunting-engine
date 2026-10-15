# ACTIVATION READINESS PACKAGE — Qualification Policy (Master Prompt 2)

> **Date:** 2026-10-15. **Outcome: ACTIVATION BLOCKED** — no owner-approved
> policy candidate exists (proven in §1–§2, not assumed). This package is the
> complete readiness record so that the moment approvals land, activation is a
> mechanical, audited step — not a new investigation.
>
> Nothing was published, mutated, committed, pushed or deployed to produce
> this package. The dev database holds zero cases, zero assessments and zero
> active versions before and after.

## 1. Approval provenance matrix

| Requirement | Owner approval artifact | Implementation artifact | Verification | Status |
|---|---|---|---|---|
| Eligibility criteria (O10) | none — register reads OPEN | `opportunity_eligibility` + gates read explicit policies; NULL until decided | register read + zero-active query | UNVERIFIED — BLOCKED |
| Service catalog (D-004) | none — proposal + PENDING record only | `public.capability` placeholders; `p2.service_catalog` empty on dev | register read + `select count(*)=0` | UNVERIFIED — BLOCKED |
| Pricing rules (D-005) | none — proposal + PENDING record only | provisional ranges in briefs | register read | UNVERIFIED — BLOCKED |
| Scoring weights/thresholds (D-006, O7) | none — proposal + PENDING record only | provisional scorecard; fixture policies test-only | register read + zero-active query | UNVERIFIED — BLOCKED |
| Retention rules (D-008) | none — proposal + PENDING record only | no deletion job; manual takedowns | register read | UNVERIFIED — BLOCKED |
| Validation protocol + thresholds (T-014, R-05, O11) | none — protocol exists, NOT STARTED, no approvals | harness + gold v1 + pre-declared thresholds (unapproved) | register + protocol read | UNVERIFIED — BLOCKED |
| Pilot acceptance (10 conditions) | none — report verdict PILOT BLOCKED | no pilot mechanism exists to activate | pilot report read | UNVERIFIED — BLOCKED |
| Service identity (B-D13) | none | session attribution only | register read | UNVERIFIED — BLOCKED (machine paths) |

Every requirement is UNVERIFIED. Per the activation gate, publication is
refused: there is no approved artifact to publish.

## 2. Policy version and artifact identity

- Approved policy artifact: **NONE EXISTS.** No policy/catalog/rubric/capacity
  content rows exist on dev (`policies=0 catalogs=0 rubrics=0 capacities=0`,
  read 2026-10-15); no reference rows of any status.
- Closest constructible candidate (packet §4.3 recommendation mapped to
  `PolicyDefinition`) was linted with the production validator: **REJECTED** —
  `weights.* must be a finite non-negative number` (×5), `weights must total
  above zero`. The linter itself is the gate, and it holds. Each missing field
  maps to an open owner decision (weights/thresholds → D-006/O7; jurisdiction
  lists, signal map, decay, capacity → O10/policy content).
- Test fixtures (`tests/qualification_fixtures.ts`) are structurally valid
  but explicitly NOT candidates: they live in test code, register only in the
  test database, and are never read by production paths.

## 3. Integrity and gate-semantics findings (audit, no code changes)

Reviewed `lib/qualification/{scoring,gates,evidence,assessments,cases}.ts`
against the packet rubric; all prior suites green (see §7):

1. Contributions cite evidence ids + versions + as_of (ScoreResult contract). ✓
2. Deterministic pure `score()`; replay-identical outputs (tested). ✓
3. Gates evaluate before dimensions; suppression pinned first; a suppressed
   row can never score eligible (tested, incl. mid-assessment race guard). ✓
4. Missing → null, excluded from composite, coverage veto (tested). No path
   converts missing into a negative finding: `recordNegativeFinding` refuses
   incomplete searches (tested). ✓
5. Contradictions block per policy; staleness labels + decays, never silently
   current (tested). ✓
6. Negative findings require what/where/when/how (422 otherwise, tested). ✓
7. Pipelines separated: compatibility filters pipeline; `direct_client` refused
   upstream (409, tested). ✓
8. Signal-level explanations via cited claim ids (tested). ✓
9. Pairwise precedence tested; reconsideration appends new versions (tested). ✓
10. Capacity order-only; idempotency keys hash all consequential inputs;
    unique constraints arbitrate concurrency (tested). ✓
11. **Verified gap (new, procedural):** nothing in the schema prevents two
    `active` versions of one kind; readers take latest by `recorded_at`.
    Behavior is deterministic (pinned by a new latest-wins test) but the
    activation procedure must verify exactly-one-active per kind — recorded
    in §8 step 3. No code change (a uniqueness rule would be a behavior
    change beyond this phase's defect-only scope).

No implementation defect found; no code changed for semantics.

## 4. Dry-run summary and exact diff

Mechanism verification only (the candidate slot is empty — §2). Method:
pure `score()` over the documented dev pool (5 GLEIF opportunities, extracted
2026-10-15T12:39:03Z — keys in §4.1), zero writes (dev cases/assessments = 0
before and after).

- **Pool A (packet-derived skeleton, lint-failing):** all 5 → `not_eligible`
  (no approved service), composite null, bands none, missing-data profiles
  complete, 0 contradictions. Fail-closed demonstrated.
- **Pool B (test fixture, explicitly NOT a candidate):** all 5 → `blocked`
  (jurisdiction: GB/EE/SE/GR companies outside the fixture US/Germany
  allow-list; `other_digital` outside the fixture web_development profile).
  Every refusal carries its reason code; nothing scored, nothing published.
- **Diff (B vs current state):** current = NO ACTIVE POLICY (all assessments
  refused with 409). B would newly gate 5 rows as blocked — informative only;
  B is unapproved fixture values and must never be published.
- Skipped records: none (all 5 had linked companies and stored evidence).
  Suppressed confirmation: 0 suppressed in pool; suppression path covered by
  suite (suppression_leakage = 0 with current-state reads).
- Capacity decisions: none (no capacity profile active; pursuit = composite).

## 5. Evaluation metrics (re-run 2026-10-15, full detail in `docs/EVALUATION_BASELINE_REPORT.md`)

Held-out (n=8): P@10 1.0, P@20 1.0, leakage 0, stability 1.0, agreement 0/1
MISS (designed disagreement, n=1 — still visible as required, threshold
unchanged). Dev (n=4): P@10/20 0.67, leakage 0, agreement 1/2, stability 1.0.
Baselines over identical pools are reported per split; small-n uncertainty is
stated per metric; five operational metrics remain UNMEASURED with capture
plans. No tuning occurred (fixture weights fixed; thresholds pre-declared).

## 6. Baseline comparison

Identical eligible pools and labels per split (see generated report tables).
On these synthetic pools all four rankers agree (expected at small-n with
separated fixtures) — the comparison is reported, and no superiority is
claimed: agreement at n≤4 cannot support one.

## 7. Regression, adversarial and database verification results

Executed 2026-10-15 (test database only; dev untouched):

- Targeted suites (8 files, 67 passed, 0 failed): policy incl. the new
  latest-wins multi-active test, decisions (conflicts/stale/suppression/
  deferral), assessments (idempotency/immutability/staleness), routes,
  lifecycle routes, evaluation harness, docs guard, migration count (44).
- Evaluation re-run: exit 0; heldout P@10/20 1.0, leakage 0, stability 1.0,
  agreement 0/1 MISS still visible (threshold unchanged); dev split all PASS
  except nothing missed. No tuning.
- Backup drill: dump 236,270 bytes + sha256 manifest; TOC readable (471
  entries); scratch restore integrity `{migrations:44, companies:8,
  claims:10, source_categories:12, audit_rows:112, orphan_claims:0}`;
  scratch dropped; retention re-applied (4 dev dumps + protected legacy).
- `db.mjs verify`: ok on dev (live data) — re-confirmed in the last full
  suite cycle per the release checklist.
- Local bindings re-confirmed: 5432/tcp → 127.0.0.1:5434 only.
- Adversarial coverage reuses the existing suites (injection text, unsafe
  URLs, script payloads, concurrent decisions, interrupted transactions,
  version changes, boundaries, supersession) — all green, none weakened.

## 8. Known limitations and unresolved risks

Small-n gold set (12 items; agreement metric needs a larger dual-reviewed
set in gold v2) · synthetic ≠ commercial outcomes · latest-wins multi-active
behavior (§3.11, procedural gate) · no off-host DR (local restore only) ·
unmeasured operational metrics · pg `int8`-as-text driver behavior at view
edges (contract casts in place, M14) · review time uninstrumented.

## 9. Activation procedure (mechanical, only when §12 conditions hold)

1. Confirm the dated owner reply + signed record for O10/D-004/D-006/O7 (and
   scope items O1/O2/O3 as needed) in the canonical registers.
2. Insert content rows (policy/catalog/rubric/capacity) with the EXACT
   approved values; lint must pass.
3. Verify **exactly one** active version per kind (see §3.11); retire any
   predecessor first.
4. Publish each kind explicitly (`publishPolicy` et al. — audited).
5. Read back active versions; compare byte-for-byte with the approved artifact.
6. Run smoke tests: assess one known opportunity, confirm outcome/band sane;
   run `db.mjs verify`; run the qualification suites.
7. Any mismatch → retire the published version immediately (rollback =
   retire; previous version, if any, re-activate explicitly — never automatic).

## 10. Post-activation smoke-test plan

Assess 3 known opportunities (eligible/blocked/not_eligible expected),
re-run evaluation on the approved policy with re-declared thresholds,
reconcile + confirm zero drift, verify backup + restore drill still green.

## 11. Rollback procedure

Retire the published version(s) (`setReferenceStatus → retired`); the engine
refuses without an active version (fail-closed = safe state). Re-activate the
predecessor only by a new explicit publish. Assessments already recorded stay
immutable and now read stale (correct — they cite a retired version).

## 12. Audit and evidence-retention plan

All publications are `reference_version` transitions (actor + timestamp);
assessments cite versions immutably; retention follows D-008 once approved —
until then, no purge automation (manual takedowns only, hash-retained).

## 13. Authorization record

**MISSING.** No owner has authorized publication of any policy version. Per
the activation gate, the policy stays inactive and this phase stops here.
