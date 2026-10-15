# POLICY PREPARATION PACKAGE (Master Prompt 2 — decision closure)

> **Date:** 2026-10-15. **Status: PREPARED, NOTHING APPROVED, NOTHING
> ACTIVATED.** The candidate below is a clearly-marked DRAFT for owner review
> (`docs/policy-candidate.v1.DRAFT.json`, `policyVersion:
> "v1-draft-2026-10-15"`). It exists nowhere except that file: zero content
> rows on dev, zero active versions before and after. Publishing it — or any
> version — requires dated approvals that do not exist.

## 1. Canonical decision status matrix (delta since Prompt 1 packet)

No change: all 19 items still OPEN/BLOCKED as recorded in
`docs/PART1_OWNER_DECISION_PACKET.md` §§9–10 (re-verified 2026-10-15: no
owner reply in any register, no signatures, no new rows). This package adds
preparation, not decisions.

## 2. Owner approval provenance

None exists. Searched: all registers, approval-ready records (all PENDING),
pilot decision record, evaluation artifacts. Provenance table: see
`docs/ACTIVATION_READINESS_PACKAGE.md` §1 (all UNVERIFIED — still true).

## 3. Service catalog and scope (none approved — D-004 OPEN)

None approved. Catalog table empty on dev; `public.capability` holds 2
placeholders. **Decision request D-004 (OPEN):** confirm the 8-line starter taxonomy
(name + entry criteria + owner per line), amend it, or supply the list from
scratch; unconfirmed lines keep every guard.

## 4. Pricing rules (none approved � D-005 OPEN, quote-only retained)

No prices approved. Briefs carry provisional ranges-with-assumptions; no rate
card exists. The draft proposes NO numbers. **Decision request D-005/O6 (OPEN):**
approve ranges-with-assumptions form (assumptions + currency + scope +
mandatory human review + provisional labeling) or supply a rate card; confirm
manual-quote-only as the fallback either way.

## 5. Deterministic scoring rubric (draft values proposed � D-006/O7 OPEN)

Draft candidate `v1-draft-2026-10-15`: 7 canonical gates with established
outcomes; worldwide jurisdictions with an explicit embargo-list question;
signal map limited to the observed `identity` predicate; equal starting
weights (NO evidence behind the values — primary amendment target);
evidence-confidence floor 30; coverage veto 0.5; bands Elite 85 / Qualified
65 / Watch 40 (or null); registry-family decay + 90-day default; lexicographic
order; null capacity; empty exclusion list with a confirmation question;
deferral bounds 30d/3x. Dimension rubric prose included (ranges and
missing-semantics structural; prose working text).
**Decision requests D-006/O7/O10 (all OPEN):** amend or confirm every PROPOSED value;
the packet §4.3 records what each number needs.

## 6. Source and evidence rules

Mechanism verified: trust registry (empty on dev = fail closed), grades
A–D with D-never-approved CHECK, independence groups, duplicate collapse,
expiry/suppression exclusion, contradiction blocking, negative-finding
validation. **Decision request (sources):** approve source registrations
(key + grade + independence group each) — unapproved sources stay unscored
regardless of accessibility. **Decision request (evidence):** confirm the
O10 evidence bar as the sufficiency rule.

## 7. Retention schedule (none approved � D-008 OPEN)

None approved. Current behavior: no purge automation, manual takedowns with
hash retention, contradictions undeletable, audit append-only (owner/superuser
limitation documented). **Decision request D-008 (OPEN):** per-class windows
(owner fills the page-window value) + legal review; until signed, nothing is
purged.

## 8. T-014 and R-05 approval status

T-014 NOT STARTED (test-guarded); protocol + template exist. R-05 OPEN (no
attestor, no frozen criteria). **Decision requests:** O11 five approvals;
R-05 attestor + criteria freeze. No protocol changes proposed here.

## 9. Outcome-linkage decision

Undecided: `outcome_log` has no case link (pilot ledger PI-04). Options: (a)
link by case_id via migration (needs owner scope decision); (b) keep
outcomes brief-scoped (metrics stay brief-level). **Decision request:**
choose (a) or (b) before pursuit metrics can exist.

## 10. Policy schema and candidate version

Schema: M17 content tables + reference lifecycle (verified, `db.mjs verify`
ok). Candidate: `v1-draft-2026-10-15` in `docs/policy-candidate.v1.DRAFT.json`
— file only, never inserted, never published.

## 11. Linter and test results (executed this phase)

- Draft JSON parses (`valid JSON`, node JSON.parse).
- Production linter on the draft: `lintPolicy → {ok:true}`,
  `lintRubric → {ok:true}` (structure only — lint approves nothing).
- Docs guard `tests/docs_consistency.test.ts`: 5 passed (covers this package
  + packet addendum: no silent approvals, IDs stable, T-014 NOT STARTED,
  links resolve).
- Full suite / build / verify / eval: per the independently verified
  53/542 figures (Master Prompt 3 phase; code unchanged since — no code
  changed in this phase at all, so no re-run warranted; see §13 diff).

## 12. Remaining blockers

All 19 packet items (O1–O11, D-003/004/005/006/008, T-014, R-05, B-D1, B-D13,
F18) + 10 pilot conditions + blind-review staffing + outcome linkage. No new
blockers found; multi-active latest-wins remains procedurally gated.

## 13. Exact diff and implementation artifacts

Phase footprint: this package (new) + draft JSON (new). Zero code, migration,
test, or data changes — verified via `git status` (only the two paths).
No implementation artifact was modified to prepare this package.

## 14. Explicit statement

The candidate remains inactive: zero content rows, zero active versions, no
publication mechanism invoked. The next step is owner review of §3–§9
requests — not implementation, not activation.
