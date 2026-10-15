# QUALIFICATION GATE AND REASON-CODE REGISTRY

> **Status:** STRUCTURE FROZEN (gate ids, outcomes, reason codes).
> Gate ORDER and failure-outcome semantics come from the ACTIVE policy, which
> does not exist yet (O10 stays OPEN) — fixtures define test policies only.
> Code: `lib/qualification/gates.ts` (pure functions). Tests:
> `tests/qualification_gates.test.ts`.

## 1. Gates (evaluation order = policy order; suppression pinned first)

| # | Gate id | Rule (short) | Failure outcome (fixture policy) |
|---|---|---|---|
| 1 | suppression | view `suppression_reason` non-null → fail. ABSOLUTE: evaluated before policy order; no override exists | not_eligible |
| 2 | jurisdiction | company country unknown → fail; on exclusion list, or allow-list present and absent → fail | blocked |
| 3 | exclusion | any `business_relationship` whose type is policy-listed → fail | not_eligible |
| 4 | service_availability | no approved service in the active catalog → fail; none compatible (pipeline/agency/country) → fail | not_eligible |
| 5 | identity_resolution | open `identity_conflict`, or no canonical company → fail | blocked |
| 6 | evidence_sufficiency | fewer usable evidence items than required → fail | needs_evidence |
| 7 | contradiction_freshness | open contradicting claim → fail; all usable evidence stale → fail | blocked |

Outcome vocabulary (lifecycle words, no duplicates): `blocked` (mandatory
condition unresolved/fails) · `needs_evidence` (possibly relevant, evidence
insufficient) · `eligible_for_assessment` (may be scored) · `not_eligible`
(approved hard gate rejects). The primary outcome is the FIRST failure in
precedence order; every failure is recorded with its reason code.

## 2. Reason codes (stable strings)

`SUPPRESSED_MERGED` · `SUPPRESSED_ARCHIVED` · `JURISDICTION_UNKNOWN` ·
`JURISDICTION_EXCLUDED` · `EXCLUDED_RELATIONSHIP` · `NO_APPROVED_SERVICE` ·
`SERVICE_INCOMPATIBLE` · `IDENTITY_AMBIGUOUS` · `IDENTITY_UNRESOLVED` ·
`EVIDENCE_INSUFFICIENT` · `CONTRADICTION_OPEN` · `EVIDENCE_STALE`.

A new reason code requires a gate rule that emits it plus a test that asserts
it; codes are never reused for a different meaning.

## 3. What the approved policy will decide (and only it)

Gate order, each gate's failure-outcome class, jurisdiction lists, exclusion
lists, the sufficiency count, and the contradiction/freshness handling are
POLICY CONTENT — supplied by the owner-approved policy version when O10 (and
jurisdiction/commercial inputs) land. Until then every assessment runs on
explicit fixture/test policies, and production has no active policy to run on
(the assess path refuses without one: 409 `no_active_reference`).
