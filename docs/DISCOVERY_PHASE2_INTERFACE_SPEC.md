# DISCOVERY → PHASE 2 INTERFACE SPECIFICATION (frozen, v1)

> **Status:** FROZEN. **Migration:** `db/migrations/20261015100001_discovery_phase2_interface.sql`
> (repaired forward-only by `...00006_view_sequence_int.sql`).
> Companion: [Phase 2 schema](PHASE2_SCHEMA.md) · [event contract](PHASE2_EVENT_CONTRACT.md) ·
> [owner decision packet](PART1_OWNER_DECISION_PACKET.md).

## 1. What is frozen

Exactly one database object: the view
`public.v_opportunity_for_qualification_v1`. Its name, its 42 columns in
contract order, each column's type and nullability rule, and the semantics in
§3 are frozen. A consumer that does not recognise this exact view name must
refuse to read rather than guess. A v2, if one is ever needed, is a NEW view;
v1 is never altered in place (its one type repair, M14, predates any consumer
and is recorded in the migration header).

## 2. Column contract

| # | Column | Type | Nullable | Owner | Meaning |
|---|---|---|---|---|---|
| 1 | opportunity_id | uuid | no | Discovery | stable identity; the join key Phase 2 stores |
| 2 | pipeline | text | no | Discovery | `agency_partner` or `direct_client` (schema permits both; the app refuses direct-client rows until O1 — still OPEN) |
| 3 | opportunity_key | text | no | Discovery | `opp:<pipeline>:<source>:<record>`; unique per pipeline; never rewritten |
| 4 | opportunity_status | text | no | Discovery | lifecycle: observed\|eligible\|ineligible\|promoted\|stale\|archived. NOT a qualification verdict |
| 5 | solution_status | text | no | Discovery | unknown\|absent_evidence\|present_confirmed\|present_unverified |
| 6 | rule_id | text | yes | Discovery | discovering rule, when one exists |
| 7 | first_seen_at | timestamptz | no | Discovery | first observation |
| 8 | opportunity_updated_at | timestamptz | no | Discovery | last lifecycle change |
| 9 | opportunity_created_at | timestamptz | no | Discovery | row creation |
| 10 | company_id | uuid | yes | Discovery | null only when the opportunity has no company |
| 11 | company_name | text | yes | Discovery | verbatim business name |
| 12 | company_domain_norm | text | yes | Discovery | null for registry sources (GLEIF carries LEI, not domains) |
| 13 | company_registry_id | text | yes | Discovery | e.g. LEI |
| 14 | company_registry_type | text | yes | Discovery | registry scheme |
| 15 | company_agency_type | text | yes | Discovery | agency taxonomy value |
| 16 | company_country | text | yes | Discovery | — |
| 17 | company_country_code | text | yes | Discovery | — |
| 18 | company_merged_into | uuid | yes | Discovery | supersession pointer; non-null means superseded |
| 19 | suppression_reason | text | yes | Discovery | DERIVED, from existing state only: `company_merged` \| `opportunity_archived` \| null. A suppressed row is non-actionable, never a new opportunity |
| 20 | eligibility_version | integer | yes | Discovery | latest decision version; NULL until an approved policy is applied (O10 — still OPEN, so NULL is the honest normal case) |
| 21 | eligibility_decision | text | yes | Discovery | eligible\|ineligible\|needs_info; NULL with 20 |
| 22 | eligibility_policy_version | text | yes | Discovery | explicit policy the decision was made under |
| 23 | eligibility_gate_reasons | jsonb | yes | Discovery | per-gate reasons exactly as recorded, never reinterpreted |
| 24 | eligibility_decided_by | text | yes | Discovery | — |
| 25 | eligibility_decided_at | timestamptz | yes | Discovery | — |
| 26–32 | evidence_claims_total/_observed/_corroborated/_inferred/_assumed/_disputed | integer | no (0 when none) | Discovery | claim counts by status for this company |
| 33 | evidence_contradicted_claims | integer | no | Discovery | claims with a `contradicts` link |
| 34 | evidence_claims_needing_review | integer | no | Discovery | — |
| 35 | evidence_latest_claim_at | timestamptz | yes | Discovery | null when no claims |
| 36 | evidence_latest_observed_at | timestamptz | yes | Discovery | — |
| 37 | provenance_sources_total | integer | no | Discovery | count of discovery records (a manual entry counts 1 with unknown source) |
| 38 | provenance_source_keys | text[] | yes | Discovery | distinct source keys; may contain null (unknown source); sorted |
| 39 | provenance_latest_recorded_at | timestamptz | yes | Discovery | — |
| 40 | provenance_records_failed | integer | no | Discovery | records with retrieval_status <> 'ok' |
| 41 | rule_version | text | yes | Discovery | mirrors 22: the version string Phase 2 must cite with any decision |
| 42 | last_event_sequence | integer | no | Discovery | highest outbox sequence for this opportunity; 0 when it produced no events yet |
| — | last_transition_actor | — | — | — | EXISTS on the view but is NOT granted to the Phase 2 role (operator attribution is not a qualification input) |

Full history stays where it belongs and is NOT flattened here:
eligibility versions in `opportunity_eligibility` (replayed via events),
claim text in `claim`, lifecycle in `audit_log`.

## 3. Semantics

- **Field ownership:** Discovery owns every value. Phase 2 never writes to
  them (proven by `tests/qualification_permissions.test.ts`: direct writes AND
  direct reads on Discovery tables are denied for the Phase 2 role).
- **Nullability:** counts are 0, never null; timestamps/ids are null only
  when the fact does not exist; eligibility fields are null until decided.
- **Identity:** `opportunity_id` is stable forever. `opportunity_key` is
  never rewritten. No per-company uniqueness is promised (multiple
  opportunities per business are allowed by design).
- **Supersession:** `company_merged_into` non-null or `suppression_reason`
  non-null means "do not act". The row is kept for audit, not deleted.
- **Eligibility:** columns 20–25 expose the LATEST decision only. Absence
  (NULL) means "not yet decided", never "failed". No default policy exists.
- **Terminal states:** `archived` opportunities and merged companies stay
  visible with `suppression_reason` set; they are never removed by sync.
- **Evidence snapshot requirement:** any assessment MUST cite the
  `p2.case_snapshot` row it was made against (the exact view row bytes +
  hash), never "the view as of today".
- **Sequence semantics:** `last_event_sequence` is per-opportunity and
  monotone; global stream order is `discovery_outbox.outbox_id`.
- **Versioning:** v1 is frozen. Consumers check the view NAME; an unknown name
  is a refusal, not a fallback.
- **Permissions:** column-level SELECT for `p2_app` on columns 1–42 except
  `last_transition_actor`; no other grants on Discovery objects.
- **Failure behaviour:** unknown opportunity → no row (not an error);
  unknown view name → SQL error (refuse, do not guess).

## 4. Contract tests and migration compatibility

- `tests/qualification_view.test.ts` (9 tests): exact column list and order,
  null-eligibility honesty, latest-decision visibility, suppression derivation,
  hash movement, paging, permission boundary (grant + denial).
- `db/tests/t002_verify.sql` §9 (added in Part 1): the view exists with all
  42 columns, the outbox and its guard exist, the `p2` schema holds 8 tables,
  both consumption functions exist, and the `p2_app` grants are present.
- Any future migration touching this view must extend §9 the same day or the
  verifier fails the build.
