-- Migration M13: default a missing consumer watermark to zero (Part 1).
--
-- Forward-only repair of M12. Root cause, found by direct execution: M12
-- replaced M10's `v_watermark := coalesce(v_watermark, 0)` with
-- `coalesce(w.last_outbox_id, 0)` INSIDE the watermark lookup. That covers a
-- NULL stored value but not the first-claim case, where the consumer has no
-- watermark row at all: a row-less SELECT INTO leaves the variable NULL, and
-- `outbox_id > NULL` matches nothing, so a brand-new consumer could never
-- claim its first event. One line restores the default. Nothing else changes.
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
  select coalesce(w.last_outbox_id, 0) into v_watermark
    from p2.consumer_watermark w where w.consumer_name = p_consumer;
  -- No watermark row yet (first claim): the variable is NULL, not zero.
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
    select c.event_id, c.outbox_id, c.opportunity_id, c.event_type, c.payload_version,
           c.sequence, c.payload, c.occurred_at, c.recorded_by, p_consumer, 'claimed'
      from candidates c
    -- Bare DO NOTHING on purpose (M12): naming the arbiter columns
    -- reintroduces OUT-parameter ambiguity.
    on conflict do nothing
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