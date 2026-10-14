# D-004 / D-005 / D-006 / D-008 — Approval-Ready Decision Records

> Status of every record below: **PENDING OWNER APPROVAL**. Each record is
> written so the owner can approve it by signing the approval block — no
> further drafting needed. Until signed, the register stays OPEN and the
> system keeps its documented provisional behavior. Nothing here authorizes
> implementation on its own. Extends `docs/MILESTONE2_DECISION_PROPOSALS.md`
> (options and trade-offs) with exact approval text.

---

## D-004 — Service/capability catalog content — PENDING

**Existing behavior.** `public.capability` holds two `needs_owner_review`
placeholders; structure final; unapproved entries can never look approved
(+0 scoring, brief disclosure, review-queue surfacing). Full detail:
proposals doc §D-004.

**Recommended policy.** Adopt the operator-confirmed starter taxonomy —
web builds, portals/dashboards, integrations/API work, automation/workflows,
reporting/analytics, QA/test systems, ecommerce tooling, mobile delivery —
with **every line `needs_owner_review` until the owner confirms each one in
writing** (name + one-line entry criteria + owner per line).

**Implications.** Security: none (catalog rows are labels, not access).
Business: proposals can map to real lines once confirmed; until then
disclosures stay. Integrity: per-line confirmation is audited; unconfirmed
lines keep every current guard.

**Alternatives:** owner supplies the list from scratch (most accurate,
slowest); keep placeholders (zero effort, features stay stubbed).

**EXACT APPROVAL REQUIRED.** Owner replies, dated:
“APPROVED D-004: the starter taxonomy above, with per-line confirmation to
follow” — or “APPROVED WITH CHANGES: <list>” — or “REJECTED: <reason>”.
Then: `setCapabilityStatus` transitions + audit; briefs stop disclosing
confirmed lines; catalog queue empties for them.

---

## D-005 — Pricing and estimation policy — PENDING

**Existing behavior.** Estimation v1 honest by construction (documented
baselines S 2–4 … XL 25–40, 15% contingency, confidence caps,
`insufficient_information` over invented precision). Prices/timelines are
operator-entered ranges-with-assumptions or absent — never converted,
derived, or defaulted. Currency preserved verbatim or absent. Commercial
page shows ranges-or-TBD with a warning banner.

**Recommended policy.** (1) Formalize current behavior as policy B:
indicative ranges allowed in briefs **only** with stated assumptions and the
"confirm in conversation" banner. (2) Record explicitly that there is **no
minimum project size** (absence of a floor is the decision). (3) Rate cards,
margin floors, and quote currency (policy A) deferred until the owner
supplies them; estimation math untouched in all cases.

**Implications.** Security: none. Business: briefs stay quotable-never,
honest-always; no revenue/ROI/budget is invented anywhere. Integrity:
`insufficient_information` remains a valid, tested outcome.

**Alternatives:** rate card now (needs upkeep); explicit minimum (may filter
real small wins).

**EXACT APPROVAL REQUIRED.** Owner replies, dated:
“APPROVED D-005: policy B formalized; no minimum recorded; rate card
deferred” — or variants with changes/rejection. Then: one-sentence policy
entry in the register; brief template wording unchanged (already compliant).

---

## D-006 — Scoring policy (weights provisional) — PENDING

**Existing behavior.** `score_v1` implemented, gated (5 hard gates, failures
produce NO row), versioned, audited; weights 30/25/20/15/10 PROVISIONAL;
deductions only in scoring; missing inputs score 0 AND are listed; queue
never uses scores; calibration protocol requires **n≥30 reviewed outcomes
with pre-decision frozen scores** before any tuning. Full spec:
`SCORING_AND_OPPORTUNITY_MODEL.md` §9, `T011_SCORING_AUDIT.md`,
`T011_CALIBRATION_PROTOCOL.md`.

**Recommended policy.** Keep provisional weights until n≥30 (protocol as
written). The Milestone-2 learning reports are the collection instrument.
Early expert review allowed only as documented sensitivity review — **never
as tuning, never to make examples look better**. Any future weight/band/gate
change requires its own dated `D-*` decision citing frozen pre-decision
scores. Minimum evidence for calibration: n≥30 genuinely reviewed cases
(approved/rejected/deferred briefs with frozen scores + terminal outcomes) —
preserved, not lowered.

**Implications.** Security: none. Business: scores stay ordering hints, never
predictions. Integrity: history preserved; reproducibility suite keeps passing.

**Alternatives:** early tuning on judgment (rejected — invalidates the
protocol baseline); threshold changes now (rejected — same reason).

**EXACT APPROVAL REQUIRED.** Owner replies, dated:
“APPROVED D-006: weights stay provisional until n≥30 per the protocol; no
tuning without a new dated decision” — or rejection with reason. Then:
register entry; no code change (the engine already enforces this).

---

## D-008 — Retention policy — PENDING

**Existing behavior.** No windows set. Snapshots carry `retention_class`;
operator-initiated snapshot DELETE permitted (explicit, tested); claim
assessments append-only with explicit removal paths; audit rows immutable to
everyone including the owner; expired operator sessions older than 7 days
purged opportunistically on login; test-only cleanups. **No automated
retention job exists.**

**Recommended policy.** Per-class windows + legal review BEFORE any deletion
job is built (proposal: registry/directory 36 mo, page/manual 24 mo,
social 12 mo — **starting numbers for legal review, not approved values**);
takedown requests honored manually via existing explicit-delete paths;
audit/provenance chains survive any rule (NFR-003); no irreversible deletion
and no automated jobs until this record is signed AND the job itself is
reviewed with dry-run + audit.

**Implications.** Security: social/PII accumulation capped after approval.
Business: legal review required (multi-jurisdiction, worldwide scope).
Integrity: dry-run lists doomed rows first; purge preserves chains; RLS
unchanged.

**Alternatives:** single global window (simpler, misfits classes); retain
everything (weakest privacy posture).

**EXACT APPROVAL REQUIRED.** Owner replies, dated:
“APPROVED D-008: per-class windows <values> + <named legal reviewer>;
authorized to build the reviewed purge job as a separate task” — or
rejection. Then: new task for the job (dry-run, audit, tests) — NOT this
milestone, NOT implicit in this signature.
