-- Migration M11: fix the `p2.claim_events` conflict arbiter (Part 1).
--
-- Forward-only repair of M10. Root cause, found by direct execution before any
-- test was written: the `insert ... select ... on conflict (consumer_name,
-- outbox_id)` inside `claim_events` fails with `column reference "outbox_id"
-- is ambiguous`, because the SELECT list produces an `outbox_id` output column
-- that collides with the target table's column when Postgres resolves the
-- arbiter. No claim could ever be delivered; every consumer saw an error.
--
-- Fix: alias the SELECT outputs so the arbiter names resolve only to the
-- target table's columns. Semantics unchanged (same rows, same dedup, same
-- `already_seen` reporting). Grants on the function survive
-- CREATE OR REPLACE. No table, column or grant is touched.
create or replace function p2.claim_events(p_consumer text, p_batch integer default 50)
returns table (
  event_id uuid,
  outbox_id bigint,
  opportunity_id uuid,
  event_type text,
  payload_version integer,
  opportunity_sequence bigint,
  payload jsonb,
  occurred_at timestamptz,
  recorded_by text,
  already_seen boolean
)
language plpgsql
security definer
set search_path = p2, public
as $$
declare
  v_watermark bigint;
  v_batch integer := least(greatest(coalesce(p_batch, 50), 1), 200);
begin
  if coalesce(length(trim(p_consumer)), 0) < 1 then
    raise exception 'consumer name is required' using errcode = '22023';
  end if;
  select last_outbox_id into v_watermark
    from p2.consumer_watermark where consumer_name = p_consumer;
  v_watermark := coalesce(v_watermark, 0);

  return query
  with candidates as (
    select o.*
      from public.discovery_outbox o
     where o.outbox_id > v_watermark
     order by o.outbox_id
     limit v_batch
       for update skip locked
  ), inserted as (
    insert into p2.event_inbox
      (event_id, outbox_id, opportunity_id, event_type, payload_version,
       opportunity_sequence, payload, occurred_at, recorded_by, consumer_name, status)
    -- Output aliases differ from the target columns on purpose: unaliased
    -- outputs make the ON CONFLICT arbiter below ambiguous (M10 defect).
    select c.event_id as src_event_id,
           c.outbox_id as src_outbox_id,
           c.opportunity_id as src_opportunity_id,
           c.event_type as src_event_type,
           c.payload_version as src_payload_version,
           c.sequence as src_sequence,
           c.payload as src_payload,
           c.occurred_at as src_occurred_at,
           c.recorded_by as src_recorded_by,
           p_consumer as src_consumer,
           'claimed' as src_status
      from candidates c
    on conflict (consumer_name, outbox_id) do nothing
    returning *
  )
  select c.event_id, c.outbox_id, c.opportunity_id, c.event_type, c.payload_version,
         c.sequence, c.payload, c.occurred_at, c.recorded_by,
         (i.event_id is null) as already_seen
    from candidates c
    left join inserted i
      on i.consumer_name = p_consumer and i.outbox_id = c.outbox_id
   order by c.outbox_id;
end;
$$;