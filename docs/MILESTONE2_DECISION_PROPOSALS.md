# MILESTONE 2 — Owner Decision Proposals (D-004 / D-005 / D-006 / D-008)

> Status: PROPOSALS FOR OWNER REVIEW. Nothing here is decided. No implementation
> in this milestone depends on these answers; the system keeps running on the
> documented provisionals. Each section ends with the explicit approval the
> owner must give before anything changes. Related: `docs/T010_OWNER_DECISIONS.md`
> (commercial questions), `docs/DECISIONS_AND_OPEN_QUESTIONS.md` (register).

## How to approve

For each decision below, the owner replies with one of: **APPROVE (as proposed)**,
**APPROVE WITH CHANGES (stated)**, or **REJECT (with reason)**. The reply itself
is recorded in the register with a date; only then does implementation begin.
Silence keeps the provisional behavior — that is deliberate, not an oversight.

---

## D-004 — Service/capability catalog content

**Current behavior.** `public.capability` holds two `needs_owner_review`
placeholder rows (`web-portal-build`, `qa-automation`). Structure
(key/name/description/entry-criteria/owner/status) is final and tested.
Proposals may link unapproved entries, but the UI labels them unapproved, the
scoring engine grants them +0, briefs disclose them, and the review queue
surfaces every unapproved entry as an owner decision. Nothing unapproved can
look approved anywhere in the system.

**Implications.** Until real content lands, proposals cannot claim Grayscales
delivery capability, briefs carry disclosure banners, and the catalog queue
stays permanently populated. Commercial depth (D-005) also stalls, since
pricing attaches to services.

**Options.**

| # | Option | Trade-off |
|---|---|---|
| A | Owner supplies the real service list (name + 1-line entry criteria + owner per line) | Accurate, minimal; some lines may need scoping help |
| B | Adopt a starter taxonomy proposed by the operator (web builds, portals/dashboards, integrations/API work, automation/workflows, reporting/analytics, QA/test systems, ecommerce tooling, mobile delivery) with every line `needs_owner_review` until confirmed | Faster to start; risks anchoring on lines Grayscales does not sell |
| C | Keep placeholders indefinitely | Zero owner effort; catalog-dependent features stay stubbed |

**Recommended default: B, with every line unapproved until the owner confirms
each one in writing.** It unblocks mapping work without asserting a single
unverified capability as fact (G1/G5 hold throughout).

**Required owner approval.** The service list itself (names + entry criteria +
owner per line), or explicit selection of option C.

**Acceptance tests (run after approval).** `setCapabilityStatus` transitions
each approved line to `approved` with audit; proposals linking them gain the
documented feasibility points; briefs stop disclosing them; the catalog queue
empties for approved lines; unapproved lines keep every current guard.

---

## D-005 — Pricing and estimation policy

**Current behavior.** Estimation v1 (T-009/D-016) is implemented and honest:
documented person-day baselines (S 2–4 … XL 25–40), multipliers, 15%
contingency default, confidence caps, `insufficient_information` instead of
invented precision. Prices and timelines are **operator-entered ranges with
assumptions or absent** — never converted, derived, or defaulted. Currency is
preserved verbatim when entered; absent otherwise. The commercial page shows
ranges-or-TBD with a warning banner.

**Implications.** Briefs cannot carry quotes, rate cards, margin floors, or
minimum project sizes. That is safe but limits the commercial case to
"effort ranges + operator ranges + assumptions".

**Options.**

| # | Option | Trade-off |
|---|---|---|
| A | Owner provides rate card (role/day ranges) + margin floor + quote currency | Real quotes possible; needs upkeep as rates change |
| B | Indicative ranges allowed in briefs with mandatory assumptions + "confirm in conversation" banner (current behavior, formalized) | No new data needed; never quotable |
| C | Adopt an explicit minimum project size (effort or value floor) | Gates trivial pursuits; may filter real small wins |
| D | No minimum (absence of a floor recorded as the decision) | Simplest; queue may fill with small items |

**Recommended default: B now, A when the owner is ready, D recorded explicitly
(no silent floor), C only on request.** Estimation math stays untouched in all
cases; only the commercial-use policy changes.

**Required owner approval.** B formalization (one sentence), plus A/C/D choices
when ready. Until then the implemented behavior is the policy.

**Acceptance tests.** Rate-card changes (if A) are versioned with audit;
briefs show ranges + assumptions + banner or nothing; no point promise can be
produced (negative test); currency always explicit when money is shown.

---

## D-006 — Opportunity scoring weights, thresholds, and gates

**Current behavior.** `score_v1` is implemented, gated, versioned, and fully
documented (`SCORING_AND_OPPORTUNITY_MODEL.md` §9, `T011_SCORING_AUDIT.md`,
`T011_CALIBRATION_PROTOCOL.md`). Weights 30/25/20/15/10 are PROVISIONAL. Five
hard gates precede every score (active, human-reviewed, canonical company,
≥1 support link, identity-clear); failures produce NO row. Deductions live
only in scoring; missing inputs score 0 AND are listed; the queue never uses
scores for priority.

**Implications.** The engine is built for recalibration but deliberately not
calibrated: ~1 reviewed opportunity exists, and the protocol requires n≥30
reviewed outcomes with pre-decision frozen scores before any tuning.

**Options.**

| # | Option | Trade-off |
|---|---|---|
| A | Keep provisional weights until n≥30 (protocol as written) | Slowest; most defensible |
| B | Early expert review of weights on synthetic + seed cases | Faster signal; risks tuning to examples (explicitly forbidden: never tune to make examples look better) |
| C | Change bands/thresholds now on judgment | Fastest; invalidates the calibration protocol's baseline |

**Recommended default: A, no exceptions.** The learning reports added in this
milestone (reply/win by segment, channel, category, source + low-data flags)
are the collection instrument for the n≥30 dataset. Option B is acceptable
only as a documented sensitivity review, never as tuning.

**Required owner approval.** Any weight/band/gate change, via a new `D-*`
decision citing the frozen pre-decision scores. Silence = weights stay
provisional.

**Acceptance tests.** The existing calibration protocol IS the test suite
(sensitivity determinism, margin stability, frozen-score comparison). No new
tests needed; the protocol must be executed, not edited, when data arrives.

---

## D-008 — Retention and deletion policy

**Current behavior.** No retention windows are set (TBD). What exists today:
snapshots carry `retention_class`; operator-initiated snapshot DELETE is
permitted (migration 8c, explicit action, tested); claim assessments are
append-only with explicit removal paths; audit rows cannot be updated or
deleted by anyone including the owner (trigger); expired operator sessions
older than 7 days are purged opportunistically on login (AUTH-001); test
databases are cleaned by test code only. **No automated retention job exists
and none is proposed here.**

**Implications.** Social/PII snapshots accumulate without a ceiling;
multi-jurisdiction variance (worldwide scope) means one window likely does not
fit all classes. Audit/provenance must survive any retention rule (NFR-003).

**Options.**

| # | Option | Trade-off |
|---|---|---|
| A | Per-class windows (registry/directory/page/social/manual) + legal review, then implement | Compliant; needs real legal input, esp. social/PII |
| B | Single global window (e.g., 24 months) for snapshots, claims kept | Simple; may over-keep social or under-keep registry |
| C | No windows (retain everything; honor takedown on request) | Zero work; unbounded growth, weakest privacy posture |

**Recommended default: A, with legal review before any deletion job is built.**
Until approved: no irreversible deletion, no automated jobs (per milestone
boundary). Takedown requests continue to be honored manually via the existing
explicit-delete paths.

**Required owner approval.** The per-class windows + who signs off on legal
review. Implementation (a tested purge job with dry-run + audit) is a separate
task AFTER approval — not this milestone.

**Acceptance tests (after approval).** Dry-run lists exactly the doomed rows;
purge preserves audit/provenance chains; RLS/noaccess behavior unchanged;
seed + verify green before and after.
