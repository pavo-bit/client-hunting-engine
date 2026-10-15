-- Migration M14: `last_event_sequence` arrives as integer (Part 1).
--
-- Forward-only repair of M9. Root cause, found by the contract tests:
-- `max(sequence)` over the bigint `sequence` column returns int8, which the
-- pg driver delivers as a STRING ('3', not 3). The frozen contract promises
-- "counts are integers", so a consumer comparing `last_event_sequence === 3`
-- would fail. Cast to int at the source: per-opportunity event counts cannot
-- approach int range. Postgres does not allow changing a view column's type
-- with CREATE OR REPLACE, so the view is dropped and recreated. Dropping a
-- view also drops its column grants, which are therefore re-issued at the end
-- of this file (same list as M9).
drop view public.v_opportunity_for_qualification_v1;
create view public.v_opportunity_for_qualification_v1 as
select
  o.id                                   as opportunity_id,
  o.pipeline                             as pipeline,
  o.opportunity_key                      as opportunity_key,
  o.status                               as opportunity_status,
  o.solution_status                      as solution_status,
  o.rule_id                              as rule_id,
  o.first_seen_at                        as first_seen_at,
  o.updated_at                           as opportunity_updated_at,
  o.created_at                           as opportunity_created_at,
  c.id                                   as company_id,
  c.name                                 as company_name,
  c.domain_norm                          as company_domain_norm,
  c.registry_id                          as company_registry_id,
  c.registry_type                        as company_registry_type,
  c.agency_type                          as company_agency_type,
  c.country                              as company_country,
  c.country_code                         as company_country_code,
  c.merged_into                          as company_merged_into,
  case
    when c.merged_into is not null then 'company_merged'
    when o.status = 'archived' then 'opportunity_archived'
    else null
  end                                    as suppression_reason,
  e.version                              as eligibility_version,
  e.decision                             as eligibility_decision,
  e.policy_version                       as eligibility_policy_version,
  e.gate_reasons                         as eligibility_gate_reasons,
  e.decided_by                           as eligibility_decided_by,
  e.decided_at                           as eligibility_decided_at,
  coalesce(ev.claims_total, 0)           as evidence_claims_total,
  coalesce(ev.claims_observed, 0)        as evidence_claims_observed,
  coalesce(ev.claims_corroborated, 0)    as evidence_claims_corroborated,
  coalesce(ev.claims_inferred, 0)        as evidence_claims_inferred,
  coalesce(ev.claims_assumed, 0)         as evidence_claims_assumed,
  coalesce(ev.claims_disputed, 0)        as evidence_claims_disputed,
  coalesce(ev.claims_contradicted, 0)    as evidence_contradicted_claims,
  coalesce(ev.claims_needing_review, 0)  as evidence_claims_needing_review,
  ev.latest_claim_at                     as evidence_latest_claim_at,
  ev.latest_observed_at                  as evidence_latest_observed_at,
  coalesce(pv.sources_total, 0)          as provenance_sources_total,
  pv.source_keys                         as provenance_source_keys,
  pv.latest_recorded_at                  as provenance_latest_recorded_at,
  coalesce(pv.records_failed, 0)         as provenance_records_failed,
  e.policy_version                       as rule_version,
  -- int8 max() arrives as text through the pg driver; the contract promises
  -- an integer, so cast at the source (see header).
  coalesce(evq.last_sequence, 0)::int    as last_event_sequence,
  coalesce(lg.actor, '')                 as last_transition_actor
from public.opportunity o
left join public.company c on c.id = o.company_id
left join lateral (
  select e2.version, e2.decision, e2.policy_version, e2.gate_reasons,
         e2.decided_by, e2.decided_at
    from public.opportunity_eligibility e2
   where e2.opportunity_id = o.id
   order by e2.version desc
   limit 1
) e on true
left join lateral (
  select count(*)::int as claims_total,
         count(*) filter (where cl.claim_status = 'observed')::int     as claims_observed,
         count(*) filter (where cl.claim_status = 'corroborated')::int as claims_corroborated,
         count(*) filter (where cl.claim_status = 'inferred')::int     as claims_inferred,
         count(*) filter (where cl.claim_status = 'assumed')::int      as claims_assumed,
         count(*) filter (where cl.claim_status = 'disputed')::int     as claims_disputed,
         count(*) filter (where coalesce(cl.needs_review, false))::int as claims_needing_review,
         count(*) filter (where exists (
           select 1 from public.claim_evidence ce
            where ce.claim_id = cl.id and ce.polarity = 'contradicts'
         ))::int as claims_contradicted,
         max(cl.created_at)  as latest_claim_at,
         max(cl.observed_at) as latest_observed_at
    from public.claim cl
   where cl.company_id = o.company_id
) ev on o.company_id is not null
left join lateral (
  select count(*)::int as sources_total,
         array_agg(distinct dr.source_key order by dr.source_key) as source_keys,
         max(dr.created_at) as latest_recorded_at,
         count(*) filter (where dr.retrieval_status <> 'ok')::int as records_failed
    from public.discovery_record dr
   where dr.company_id = o.company_id
) pv on o.company_id is not null
left join lateral (
  select max(x.sequence) as last_sequence
    from public.discovery_outbox x
   where x.opportunity_id = o.id
) evq on true
left join lateral (
  -- audit_log.entity_id is text while opportunity.id is uuid: compare as
  -- text (an uncast comparison fails with "operator does not exist").
  select a.actor
    from public.audit_log a
   where a.entity_type = 'opportunity' and a.entity_id = o.id::text
   order by a.created_at desc, a.id desc
   limit 1
) lg on true;
comment on view public.v_opportunity_for_qualification_v1 is
  'Frozen Discovery->Phase 2 qualification contract (v1). Read-only. Column set is frozen; a consumer that does not recognise this view name must refuse rather than guess. Contains no qualification content: O10 (eligibility criteria) is still OPEN, so eligibility_decision is NULL until an approved policy is applied.';

-- Re-issued: DROP VIEW above removed the M9 column grants.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'p2_app') then
    grant usage on schema public to p2_app;
    grant select (opportunity_id, pipeline, opportunity_key, opportunity_status,
                  solution_status, rule_id, first_seen_at, opportunity_updated_at,
                  opportunity_created_at, company_id, company_name,
                  company_domain_norm, company_registry_id, company_registry_type,
                  company_agency_type, company_country, company_country_code,
                  company_merged_into, suppression_reason, eligibility_version,
                  eligibility_decision, eligibility_policy_version,
                  eligibility_gate_reasons, eligibility_decided_by,
                  eligibility_decided_at, evidence_claims_total,
                  evidence_claims_observed, evidence_claims_corroborated,
                  evidence_claims_inferred, evidence_claims_assumed,
                  evidence_claims_disputed, evidence_contradicted_claims,
                  evidence_claims_needing_review, evidence_latest_claim_at,
                  evidence_latest_observed_at, provenance_sources_total,
                  provenance_source_keys, provenance_latest_recorded_at,
                  provenance_records_failed, rule_version, last_event_sequence)
      on public.v_opportunity_for_qualification_v1 to p2_app;
  end if;
end;
$$;