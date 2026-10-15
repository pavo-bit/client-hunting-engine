-- Migration M12: resolve PL/pgSQL variable/column ambiguity in the Phase 2
-- consumption functions (Part 1).
--
-- Forward-only repair of M10/M11. Root cause, found by direct execution: both
-- functions declare RETURNS TABLE output parameters (claim: event_id,
-- outbox_id, ...; ack: event_status, last_outbox_id, unsettled), and output
-- parameters ARE PL/pgSQL variables. Every unqualified column reference that
-- shares one of those names fails at runtime with
-- `column reference "..." is ambiguous`. M11 fixed the SELECT-output side but
-- the OUT-parameter side remained, so claiming still failed.
--
-- Convention from here on (documented so the next function gets it right):
-- inside these functions EVERY column reference is table-qualified, and the
-- ON CONFLICT clause carries no column list at all (bare DO NOTHING — exact
-- here, because the only unique constraints on the inbox are its PK and the
-- consumer+outbox key, both of which mean "already delivered"). Grants survive
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
  select coalesce(w.last_outbox_id, 0) into v_watermark
    from p2.consumer_watermark w where w.consumer_name = p_consumer;

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
    -- Bare DO NOTHING on purpose (see header): naming the arbiter columns
    -- reintroduces the OUT-parameter ambiguity this migration removes.
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

create or replace function p2.ack_event(
  p_consumer text,
  p_event_id uuid,
  p_status text,
  p_error text default null
) returns table (
  event_status text,
  last_outbox_id bigint,
  unsettled bigint
)
language plpgsql
security definer
set search_path = p2, public
as $$
declare
  v_old text;
  v_status text;
  v_next bigint;
  v_stored bigint;
  v_unsettled bigint;
begin
  if p_status not in ('applied', 'rejected', 'dead') then
    raise exception 'ack status must be applied, rejected or dead' using errcode = '22023';
  end if;

  select i.status into v_old
    from p2.event_inbox i
   where i.consumer_name = p_consumer and i.event_id = p_event_id;
  if v_old is null then
    raise exception 'event % was not delivered to consumer %', p_event_id, p_consumer
      using errcode = '22023';
  end if;

  if v_old = 'claimed' then
    update p2.event_inbox e
       set status = p_status,
           settled_at = now(),
           last_error = left(coalesce(p_error, ''), 2000)
     where e.consumer_name = p_consumer and e.event_id = p_event_id;

    insert into p2.audit_event (entity_type, entity_id, action, actor, detail)
    values ('event', p_event_id::text, 'event_' || p_status, p_consumer,
            (select jsonb_build_object('outbox_id', q.outbox_id, 'event_type', q.event_type)
               from p2.event_inbox q
              where q.consumer_name = p_consumer and q.event_id = p_event_id));
  end if;
  -- else: already settled - idempotent no-op, report the stored state.

  select s.status into v_status
    from p2.event_inbox s
   where s.consumer_name = p_consumer and s.event_id = p_event_id;

  -- Minimum outbox position with no settled inbox row for this consumer;
  -- the watermark is one below it. When everything is settled the minimum is
  -- empty and the watermark becomes the outbox maximum.
  select coalesce(
           (select min(x.outbox_id)
              from public.discovery_outbox x
             where not exists (
               select 1 from p2.event_inbox i
                where i.consumer_name = p_consumer
                  and i.outbox_id = x.outbox_id
                  and i.status <> 'claimed'
             )),
           (select coalesce(max(d.outbox_id), 0) + 1 from public.discovery_outbox d)
         ) - 1 into v_next;

  select coalesce(w.last_outbox_id, 0) into v_stored
    from p2.consumer_watermark w where w.consumer_name = p_consumer;
  v_next := greatest(v_next, v_stored);

  insert into p2.consumer_watermark
    (consumer_name, last_outbox_id, updated_at, last_event_at, applied_count, dead_count)
  values (p_consumer, v_next, now(),
          (select max(y.occurred_at) from p2.event_inbox y
            where y.consumer_name = p_consumer and y.outbox_id <= v_next),
          (select count(*)::bigint from p2.event_inbox y
            where y.consumer_name = p_consumer and y.status = 'applied' and y.outbox_id <= v_next),
          (select count(*)::bigint from p2.event_inbox y
            where y.consumer_name = p_consumer and y.status = 'dead' and y.outbox_id <= v_next))
  on conflict (consumer_name) do update
    set last_outbox_id = excluded.last_outbox_id,
        updated_at = excluded.updated_at,
        last_event_at = excluded.last_event_at,
        applied_count = excluded.applied_count,
        dead_count = excluded.dead_count;

  select count(*)::bigint into v_unsettled
    from p2.event_inbox z where z.consumer_name = p_consumer and z.status = 'claimed';

  return query select v_status, v_next, v_unsettled;
end;
$$;