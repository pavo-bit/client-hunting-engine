-- Migration M9: the frozen Discovery -> Phase-2 interface (Part 1).
--
-- Forward-only. No existing row is touched, no column changes, nothing is
-- backfilled, and no Phase 2 business rule is invented here.
--
-- WHY THIS EXISTS
-- Discovery and Qualification & Prioritization share one PostgreSQL instance
-- and must not share write access. Phase 2 therefore gets exactly two things
-- from Discovery:
--   1. a READ-ONLY, versioned view (`v_opportunity_for_qualification_v1`)
--      that is the single qualification contract - current truth; and
--   2. an APPEND-ONLY outbox of durable change notifications, readable and
--      claimable only through narrowly scoped functions.
-- There is no message broker (AGENTS.md forbids one): the outbox table IS the
-- queue, and the transaction that changes Discovery state also writes its
-- event, so an event can never exist without the state or vice versa.
--
-- WHAT IS DELIBERATELY NOT HERE
--   * no scoring, weights, rubric or eligibility CONTENT (O10 is open);
--   * no Phase 2 tables (M10) and no Phase 2 lifecycle decisions;
--   * no scheduler: producing events is a side effect of operator actions
--     Discovery already performs, and consuming them is an explicit operator
--     command (never automatic, never scheduled).
--
-- IDENTITY AND SUPERSESSION: an opportunity row is superseded (not deleted)
-- by `company.merged_into` (the business was merged into a canonical record)
-- or by `status = 'archived'`. Both are exposed as raw fields plus a derived
-- `suppression_reason`; Phase 2 must treat a suppressed row as non-actionable
-- rather than as a new opportunity.

-- ---------------------------------------------------------------- outbox
create table public.discovery_outbox (
  -- Global stream position. This is the consumer's ordering key; it is NOT a
  -- business sequence and carries no meaning beyond "recorded in this order".
  outbox_id bigint generated always as identity primary key,
  -- Stable external identity: same value for every consumer, forever.
  event_id uuid not null unique default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunity (id) on delete cascade,
  -- Per-opportunity monotonic sequence. Gaps are impossible by construction
  -- (allocated under a row lock inside the writing transaction).
  sequence bigint not null check (sequence >= 1),
  event_type text not null check (event_type in (
    'opportunity_registered', 'opportunity_status_changed', 'eligibility_decided'
  )),
  -- Payload envelope version, so a consumer can refuse what it cannot read
  -- instead of misinterpreting it. v1 is the only version defined so far.
  payload_version integer not null default 1 check (payload_version >= 1),
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  recorded_by text not null check (char_length(recorded_by) between 1 and 200),
  unique (opportunity_id, sequence)
);
create index discovery_outbox_opportunity_idx
  on public.discovery_outbox (opportunity_id, sequence);
create index discovery_outbox_time_idx on public.discovery_outbox (occurred_at);

alter table public.discovery_outbox enable row level security;
revoke all on public.discovery_outbox from public;

-- Append-only, with the T-007 exemption already used for claim_assessment
-- and opportunity_eligibility: UPDATE is forbidden (silent rewriting is the
-- tampering vector), while DELETE stays possible only as the cascade
-- consequence of removing the parent opportunity (retention/takedown).
create or replace function public.t015_guard_outbox_append_only()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'DELETE' then
    return old; -- permitted: cascade from opportunity removal (see header)
  end if;
  raise exception 'discovery_outbox is append-only (INSERT + SELECT only; UPDATE is forbidden)';
end;
$$;

create trigger discovery_outbox_append_only
  before update or delete on public.discovery_outbox
  for each row execute function public.t015_guard_outbox_append_only();

-- Append one event inside the caller's transaction. SECURITY DEFINER is not
-- used: the application already owns these tables; the function exists to make
-- sequence allocation atomic and impossible to bypass by convention.
--
-- Grants are revoked from PUBLIC so a Phase 2 principal can never write INTO
-- Discovery's event history - Phase 2 consumes events, it does not produce
-- them.
create or replace function public.discovery_append_event(
  p_opportunity_id uuid,
  p_event_type text,
  p_payload jsonb,
  p_recorded_by text
) returns uuid
language plpgsql
as $$
declare
  v_next bigint;
  v_event uuid;
begin
  if p_event_type not in ('opportunity_registered', 'opportunity_status_changed', 'eligibility_decided') then
    raise exception 'unknown discovery event type: %', p_event_type using errcode = '22023';
  end if;
  if coalesce(length(trim(p_recorded_by)), 0) < 1 or length(p_recorded_by) > 200 then
    raise exception 'recorded_by is required for event attribution' using errcode = '22023';
  end if;
  if not exists (select 1 from public.opportunity where id = p_opportunity_id) then
    raise exception 'opportunity % does not exist', p_opportunity_id using errcode = '22023';
  end if;
  -- Lock the opportunity row: concurrent writers serialize here, so two events
  -- can never claim the same sequence and no sequence number is skipped.
  perform 1 from public.opportunity where id = p_opportunity_id for update;
  select coalesce(max(sequence), 0) + 1 into v_next
    from public.discovery_outbox where opportunity_id = p_opportunity_id;
  insert into public.discovery_outbox
    (opportunity_id, sequence, event_type, payload_version, payload, recorded_by)
  values (p_opportunity_id, v_next, p_event_type, 1, coalesce(p_payload, '{}'::jsonb), p_recorded_by)
  returning event_id into v_event;
  return v_event;
end;
$$;

revoke all on function public.discovery_append_event(uuid, text, jsonb, text) from public;

-- ------------------------------------------- frozen qualification interface
-- CONTRACT: v1. Column list, types and nullability are frozen; consumers must
-- refuse a view they do not recognise rather than read a changed meaning.
--
-- Ownership (which side owns each field):
--   Discovery owns every value here. Phase 2 never writes to them.
--
-- Normalization:
--   * identifiers are text already canonical (lower-cased) by Discovery;
--   * counts are integers, 0 rather than NULL when there is nothing to count;
--   * timestamps are timestamptz, NULL only when the fact does not exist yet;
--   * `gate_reasons` is jsonb exactly as recorded, never reinterpreted here.
create view public.v_opportunity_for_qualification_v1 as
select
  -- identity
  o.id                                   as opportunity_id,
  o.pipeline                             as pipeline,
  o.opportunity_key                      as opportunity_key,
  -- lifecycle state (Phase 1 vocabulary; NOT a qualification verdict)
  o.status                               as opportunity_status,
  o.solution_status                      as solution_status,
  o.rule_id                              as rule_id,
  o.first_seen_at                        as first_seen_at,
  o.updated_at                           as opportunity_updated_at,
  o.created_at                           as opportunity_created_at,
  -- business identity + supersession
  c.id                                   as company_id,
  c.name                                 as company_name,
  c.domain_norm                          as company_domain_norm,
  c.registry_id                          as company_registry_id,
  c.registry_type                        as company_registry_type,
  c.agency_type                          as company_agency_type,
  c.country                              as company_country,
  c.country_code                         as company_country_code,
  c.merged_into                          as company_merged_into,
  -- derived suppression, from existing state ONLY (no new policy):
  -- 'company_merged' when the business was superseded by a canonical record,
  -- 'opportunity_archived' when the operator archived the opportunity.
  case
    when c.merged_into is not null then 'company_merged'
    when o.status = 'archived' then 'opportunity_archived'
    else null
  end                                    as suppression_reason,
  -- eligibility: the LATEST decision only. Full version history stays in
  -- `opportunity_eligibility` (append-only) and is replayed via events.
  e.version                              as eligibility_version,
  e.decision                             as eligibility_decision,
  e.policy_version                       as eligibility_policy_version,
  e.gate_reasons                         as eligibility_gate_reasons,
  e.decided_by                           as eligibility_decided_by,
  e.decided_at                           as eligibility_decided_at,
  -- evidence facts (counts and freshness; no claim text, no snapshot bodies)
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
  -- provenance (counts + latest, never the raw payloads)
  coalesce(pv.sources_total, 0)          as provenance_sources_total,
  pv.source_keys                         as provenance_source_keys,
  pv.latest_recorded_at                  as provenance_latest_recorded_at,
  coalesce(pv.records_failed, 0)         as provenance_records_failed,
  -- rule/version references Phase 2 must record with any decision
  e.policy_version                       as rule_version,
  -- per-opportunity stream position: the highest event sequence Discovery has
  -- recorded for this opportunity, or 0 when it has produced no events yet.
  coalesce(evq.last_sequence, 0)         as last_event_sequence,
  -- operator attribution. Present on the view for audit, but NOT granted to
  -- the Phase 2 role: qualification does not need operator identity.
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
  -- text. (An uncast `a.entity_id = o.id` fails the whole migration with
  -- "operator does not exist: text = uuid".)
  select a.actor
    from public.audit_log a
   where a.entity_type = 'opportunity' and a.entity_id = o.id::text
   order by a.created_at desc, a.id desc
   limit 1
) lg on true;

comment on view public.v_opportunity_for_qualification_v1 is
  'Frozen Discovery->Phase 2 qualification contract (v1). Read-only. Column set is frozen; a consumer that does not recognise this view name must refuse rather than guess. Contains no qualification content: O10 (eligibility criteria) is still OPEN, so eligibility_decision is NULL until an approved policy is applied.';

revoke all on public.v_opportunity_for_qualification_v1 from public;

-- Grants for the Phase 2 principal, applied only when the role exists
-- (scripts/db.mjs bootstrap creates it, like `noaccess`). A database that has
-- never been bootstrapped simply has no Phase 2 principal - it fails closed,
-- and the verifier reports that state explicitly rather than passing silently.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'p2_app') then
    grant usage on schema public to p2_app;
    -- Approved qualification interface: read the view, column by column.
    -- `last_transition_actor` is deliberately withheld (operator attribution
    -- is not a qualification input).
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