# PHASE 2 DATA DICTIONARY (appendix to the project data model)

> Conventions follow `docs/DATA_MODEL_AND_EVIDENCE.md` (claim statuses,
> reliability/credibility axes, append-only discipline). This file defines
> every Phase 2 table, column rule and lifecycle; Discovery tables are
> referenced, never redefined.

## 1. Content tables (policy/catalog/rubric/capacity/trust)

| Table | Key | Content column | Lifecycle |
|---|---|---|---|
| p2.scoring_policy | policy_version (1..80) | definition jsonb (object): gates[], jurisdictions{}, signalMap{}, weights{}, floors{}, minCoverage 0..1, bands[]\|null, timing{}, freshnessDefaultDays, ranking{}, capacity{}, exclusions{} | reference_version(kind='policy') |
| p2.service_catalog | (catalog_version, service_id) | definition jsonb: serviceId/name/status/buyer/profiles/problems/signalFamilies/antiSignals/requiredEvidence/geography/pipelines/engagementRoutes/freshnessRules/effectiveDate/policyCompat/rubricCompat | per-service status + reference_version(kind='service_catalog') |
| p2.rubric | rubric_version | dimensions jsonb: per-dimension {range[lo,hi], inputs[], missingSemantics, evidence, rubric} | reference_version(kind='rubric') |
| p2.capacity_profile | capacity_version | definition jsonb: {maxActivePursuits\|null, focusServices[], focusPipelines[], notes} | reference_version(kind='capacity') |
| p2.source_trust | source_key | trust_grade A\|B\|C\|D; approved_for_scoring bool (default false; D can never be approved — CHECK); independence_group; notes | corrected in place, never deleted |

Service status values: draft (being written) · blocked (owner input missing —
cannot be published as approved) · approved (usable from an active catalog) ·
retired. Only `approved` services in an `active` catalog version score.

Trust grades: A verified registry/official record · B established directory
or press · C unverified/UGC (usable only when explicitly approved AND labelled
on the item) · D untrusted (never approved). Absent row = unapproved =
excluded from scoring inputs, listed transparently.

## 2. Case tables

| Table | Key | State columns | Rules |
|---|---|---|---|
| p2.case | case_id | discovery_opportunity_id UNIQUE (plain uuid, NOT an FK — never blocks Discovery); discovery_opportunity_key; pipeline; status (workflow: discovered→assessing→assessed/rejected/archived, edges enforced); discovery_updated_at; discovery_state_hash (sha256 of the reconciled view row); drift_detected_at (set once, never auto-cleared); latest_sequence | updates limited to workflow columns for p2_app; no delete |
| p2.case_snapshot | snapshot_id | case_id FK cascade; opportunity_id; schema_version (view version consumed); row_hash (sha256 of canonical view-row bytes); view_row jsonb (the exact bytes assessed); captured_by/reason/at | unique (opportunity_id, row_hash) → identical state deduplicates |
| p2.case_assessment | assessment_id | case_id FK cascade; version (monotone per case, under lock); rubric/policy/service_catalog/capacity versions cited; assessment jsonb (full ScoreResult); input_snapshot_id FK; as_of; snapshot_hash (Discovery-state hash, comparable via stateHashOf); code_version (engine); decided_by/at; note | append-only (UPDATE refused at DB level); versions never overwritten |
| p2.research_task | task_id | case_id FK cascade; snapshot_id FK (the snapshot the question was derived from); question; reason_code (GATE_* / MISSING_* / CONTRADICTION_OPEN); dimension; gate; evidence_needed; expected_impact high\|med\|low; uncertainty; source_availability; effort_estimate low\|med\|high; priority_explanation; status open→accepted→done / →dismissed / dismissed→open; operator_notes | no auto-execution; dedup per (case, question) among open/accepted |
| p2.negative_finding | finding_id | case_id FK cascade; snapshot_id FK; question; searched_where/at; method; actor | refused unless what/where/when/how all present |
| p2.ranking_snapshot | ranking_id | policy/catalog/rubric/capacity versions; as_of; ordered jsonb [{case_id, opportunity_id, composite, pursuit, band, rank, cutoff, excluded_reason}]; input_hash (reproducibility); created_by | immutable by convention (no updates granted meaningfully used) |

## 3. Event tables (Part 1, restated for completeness)

`public.discovery_outbox` (outbox_id identity PK; event_id unique; per-opportunity
sequence unique; three event types; payload v1; append-only guard) ·
`p2.event_inbox` (composite PK (consumer, event); unique (consumer, outbox);
claimed→applied|rejected|dead; never deleted) · `p2.consumer_watermark`
(contiguous-prefix rule) · `p2.idempotency_record` (PK (scope, key)) ·
`p2.audit_event` (append-only) · `p2.reference_version` (draft→active→retired
for policy/service_catalog/rubric/schema/capacity).

## 4. Dimension value semantics

Every dimension score is 0..100 or null. Null means unscored (missing inputs),
never zero and never imputed; nulls are excluded from the composite and count
against weight coverage. Composite = normalized-weighted mean over scored
intrinsic dimensions, vetoed below `minCoverage`. Bands label composites only
when the policy defines them. `pursuit_priority` = composite ± capacity
alignment (order only). Scores are ordinal within a policy version — never
probabilities, never conversion estimates.
