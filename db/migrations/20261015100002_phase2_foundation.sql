-- Migration M10: the minimum Phase 2 (Qualification & Prioritization) data
-- foundation, Part 1.
--
-- Forward-only. Nothing Discovery owns is altered here; this adds a SEPARATE
-- schema that may never write back into `public`.
--
-- SCOPE DISCIPLINE (deliberate omissions):
--   * no scoring weights, rubric CONTENT or eligibility rules - those are
--     owner decisions (O3/O10/O7) and inventing them is forbidden;
--   * no lifecycle UI, no autonomous worker, no scheduler, no outreach;
--   * `p2.case.status` is a WORKFLOW state (discovered -> assessing ->
--     assessed/rejected/archived), never a qualification verdict;
--   * no foreign key from `p2` to `public.opportunity`: Phase 2 must never be
--     able to block, cascade or lock a Discovery row. The identifier is stored
--     as a plain uuid and drift is detected by reconciliation.
--
-- THREE DISTINCT OPERATIONS (kept apart on purpose):
--   1. event consumption    - `p2.claim_events` / `p2.ack_event` (below);
--   2. reconciliation      - compares the frozen view with `p2.case`
--                            (application-level, operator-triggered);
--   3. historical replay   - reconstructs from retained payloads in
--                            `p2.case_snapshot` + outbox events, never from a
--                            current-state view alone.
-- None of them run automatically or on a schedule.

create schema if not exists p2;
revoke all on schema p2 from public;

-- ------------------------------------------------------------------ cases
create table p2.case (
  case_id uuid primary key default gen_random_uuid(),
  case_ref text not null unique
    default ('CASE-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  -- Stable Discovery identifier. Deliberately NOT a foreign key (see header).
  discovery_opportunity_id uuid not null unique,
  discovery_opportunity_key text not null,
  pipeline text not null check (pipeline in ('agency_partner', 'direct_client')),
  -- Workflow state only; a qualification decision lives in `case_assessment`.
  status text not null default 'discovered' check (status in (
    'discovered', 'assessing', 'assessed', 'rejected', 'archived'
  )),
  -- Last Discovery state this case was reconciled against (drift detection).
  discovery_updated_at timestamptz not null,
  discovery_state_hash text not null check (char_length(discovery_state_hash) between 1 and 64),
  -- Set when reconciliation sees Discovery has moved on. Never auto-cleared.
  drift_detected_at timestamptz,
  latest_sequence bigint not null default 0 check (latest_sequence >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text not null check (char_length(created_by) between 1 and 200)
);
create index p2_case_status_idx on p2.case (status);
create index p2_case_drift_idx on p2.case (drift_detected_at) where drift_detected_at is not null;

create trigger p2_case_set_updated_at
  before update on p2.case
  for each row execute function public.t002_set_updated_at();

-- ------------------------------------------- immutable snapshot foundation
-- The exact qualification-view row an assessment was made against. Replay and
-- audit-grade reproduction read THIS, not today's view.
create table p2.case_snapshot (
  snapshot_id uuid primary key default gen_random_uuid(),
  case_id uuid not null references p2.case (case_id) on delete cascade,
  opportunity_id uuid not null,
  schema_version text not null check (char_length(schema_version) between 1 and 80),
  row_hash text not null check (char_length(row_hash) between 1 and 64),
  view_row jsonb not null,
  captured_at timestamptz not null default now(),
  captured_by text not null check (char_length(captured_by) between 1 and 200),
  captured_reason text not null default 'reconciliation'
    check (char_length(captured_reason) between 1 and 200),
  -- Idempotent backfill: re-running a capture of identical state stores one row.
  unique (opportunity_id, row_hash)
);
create index p2_case_snapshot_case_idx on p2.case_snapshot (case_id, captured_at desc);

-- -------------------------------------------- immutable assessment storage
create table p2.case_assessment (
  assessment_id uuid primary key default gen_random_uuid(),
  case_id uuid not null references p2.case (case_id) on delete cascade,
  version integer not null check (version >= 1),
  -- Version references, not content. Until O7/D-006/O10 are decided these stay
  -- provisional and are recorded verbatim so old decisions remain readable.
  rubric_version text check (rubric_version is null or char_length(rubric_version) between 1 and 80),
  policy_version text check (policy_version is null or char_length(policy_version) between 1 and 80),
  service_catalog_version text
    check (service_catalog_version is null or char_length(service_catalog_version) between 1 and 80),
  assessment jsonb not null,
  input_snapshot_id uuid references p2.case_snapshot (snapshot_id),
  decided_by text not null check (char_length(decided_by) between 1 and 200),
  decided_at timestamptz not null default now(),
  note text,
  unique (case_id, version)
);
create index p2_case_assessment_case_idx on p2.case_assessment (case_id, version desc);

-- --------------------------------------------------- audit-event foundation
create table p2.audit_event (
  audit_id bigint generated always as identity primary key,
  entity_type text not null check (char_length(entity_type) between 1 and 80),
  entity_id text not null check (char_length(entity_id) between 1 and 200),
  action text not null check (char_length(action) between 1 and 80),
  actor text not null check (char_length(actor) between 1 and 200),
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index p2_audit_entity_idx on p2.audit_event (entity_type, entity_id, occurred_at desc);

-- ------------------------------------------------------- idempotency store
create table p2.idempotency_record (
  scope text not null check (char_length(scope) between 1 and 80),
  key text not null check (char_length(key) between 1 and 200),
  request_hash text not null check (char_length(request_hash) between 1 and 64),
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (scope, key)
);

-- ------------------------------------------- event inbox + consumer watermark
-- Delivery is at-least-once. `event_id` is the dedup key, so redelivery after
-- an interruption is safe. Rows are never deleted: a poisoned event stays here
-- as the dead-letter record.
create table p2.event_inbox (
  event_id uuid primary key,
  outbox_id bigint not null,
  opportunity_id uuid not null,
  event_type text not null,
  payload_version integer not null check (payload_version >= 1),
  opportunity_sequence bigint not null check (opportunity_sequence >= 1),
  payload jsonb not null,
  occurred_at timestamptz not null,
  recorded_by text not null,
  -- claimed -> applied | rejected | dead. `dead` IS the dead-letter state.
  status text not null default 'claimed' check (status in (
    'claimed', 'applied', 'rejected', 'dead'
  )),
  consumer_name text not null check (char_length(consumer_name) between 1 and 80),
  attempts integer not null default 1 check (attempts >= 1),
  first_seen_at timestamptz not null default now(),
  settled_at timestamptz,
  last_error text,
  unique (consumer_name, outbox_id)
);
create index p2_event_inbox_pending_idx on p2.event_inbox (consumer_name, status, outbox_id);
create index p2_event_inbox_dead_idx on p2.event_inbox (settled_at desc) where status = 'dead';

create table p2.consumer_watermark (
  consumer_name text primary key check (char_length(consumer_name) between 1 and 80),
  -- Highest Discovery outbox position whose events are ALL settled for this
  -- consumer. Never jumps over an unsettled event, so a gap stays visible.
  last_outbox_id bigint not null default 0 check (last_outbox_id >= 0),
  updated_at timestamptz not null default now(),
  last_event_at timestamptz,
  applied_count bigint not null default 0 check (applied_count >= 0),
  dead_count bigint not null default 0 check (dead_count >= 0)
);

-- --------------------------------------------- reference version registry
create table p2.reference_version (
  kind text not null check (kind in ('policy', 'service_catalog', 'rubric', 'schema')),
  version text not null check (char_length(version) between 1 and 80),
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  notes text,
  activated_at timestamptz,
  retired_at timestamptz,
  recorded_by text not null check (char_length(recorded_by) between 1 and 200),
  recorded_at timestamptz not null default now(),
  primary key (kind, version)
);

-- ------------------------------------------------- append-only protections
-- Same T-007 pattern as `claim_assessment` / `opportunity_eligibility`: UPDATE
-- is forbidden, DELETE stays possible only as a cascade from the parent case,
-- so an assessment or audit row can never be quietly rewritten.
create or replace function public.t016_guard_p2_append_only()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'DELETE' then
    return old; -- permitted: cascade from case removal (test isolation only)
  end if;
  raise exception '% is append-only (INSERT + SELECT only; UPDATE is forbidden)', TG_TABLE_NAME;
end;
$$;

create trigger p2_case_assessment_append_only
  before update or delete on p2.case_assessment
  for each row execute function public.t016_guard_p2_append_only();

create trigger p2_audit_event_append_only
  before update or delete on p2.audit_event
  for each row execute function public.t016_guard_p2_append_only();

alter table p2.case enable row level security;
alter table p2.case_snapshot enable row level security;
alter table p2.case_assessment enable row level security;
alter table p2.audit_event enable row level security;
alter table p2.idempotency_record enable row level security;
alter table p2.event_inbox enable row level security;
alter table p2.consumer_watermark enable row level security;
alter table p2.reference_version enable row level security;

-- ------------------------------------------- narrow Phase 2 consumption API
-- Phase 2 may read the approved view, but it may NOT write Discovery tables
-- and may NOT read the outbox directly. Claiming and acknowledgement go
-- through these two SECURITY DEFINER functions and nothing else.
--
-- Claim is at-least-once and idempotent per (consumer, event): it inserts the
-- inbox row `on conflict do nothing`, so a redelivery after a crash never
-- duplicates work and never advances the watermark on its own.
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
    select c.event_id, c.outbox_id, c.opportunity_id, c.event_type, c.payload_version,
           c.sequence, c.payload, c.occurred_at, c.recorded_by, p_consumer, 'claimed'
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

-- Acknowledge one delivered event. Terminal states are 'applied' (handled),
-- 'rejected' (refused by contract, e.g. an unknown payload version) and 'dead'
-- (poison: unprocessable after repeated failures).
--
-- IDEMPOTENT: the row's pre-update status is read first. Re-acking an already
-- settled event returns the STORED state and writes no second audit row.
-- (An earlier draft compared the status AFTER the update, which always matched
-- and duplicated the audit row on every re-ack.)
--
-- The watermark advances ONLY across a contiguous settled prefix: it is the
-- minimum unsettled outbox position minus one, so a gap keeps the watermark
-- behind it instead of silently skipping undelivered work. It is additionally
-- guarded with greatest() against the stored value, so it can never move
-- backwards even if outbox rows are ever removed by a cascade.
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
  v_row record;
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
    update p2.event_inbox
       set status = p_status,
           settled_at = now(),
           last_error = left(coalesce(p_error, ''), 2000)
     where consumer_name = p_consumer and event_id = p_event_id;

    insert into p2.audit_event (entity_type, entity_id, action, actor, detail)
    values ('event', p_event_id::text, 'event_' || p_status, p_consumer,
            (select jsonb_build_object('outbox_id', outbox_id, 'event_type', event_type)
               from p2.event_inbox
              where consumer_name = p_consumer and event_id = p_event_id));
  end if;
  -- else: already settled - idempotent no-op, report the stored state.

  select * into v_row from p2.event_inbox
   where consumer_name = p_consumer and event_id = p_event_id;

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
           (select coalesce(max(outbox_id), 0) + 1 from public.discovery_outbox)
         ) - 1 into v_next;

  select coalesce(last_outbox_id, 0) into v_stored
    from p2.consumer_watermark where consumer_name = p_consumer;
  v_next := greatest(v_next, v_stored);

  insert into p2.consumer_watermark
    (consumer_name, last_outbox_id, updated_at, last_event_at, applied_count, dead_count)
  values (p_consumer, v_next, now(),
          (select max(occurred_at) from p2.event_inbox
            where consumer_name = p_consumer and outbox_id <= v_next),
          (select count(*)::bigint from p2.event_inbox
            where consumer_name = p_consumer and status = 'applied' and outbox_id <= v_next),
          (select count(*)::bigint from p2.event_inbox
            where consumer_name = p_consumer and status = 'dead' and outbox_id <= v_next))
  on conflict (consumer_name) do update
    set last_outbox_id = excluded.last_outbox_id,
        updated_at = excluded.updated_at,
        last_event_at = excluded.last_event_at,
        applied_count = excluded.applied_count,
        dead_count = excluded.dead_count;

  select count(*)::bigint into v_unsettled
    from p2.event_inbox where consumer_name = p_consumer and status = 'claimed';

  return query select v_row.status::text, v_next, v_unsettled;
end;
$$;

-- Deliberately NOT granted: no function that mutates `public.*`, and no direct
-- table privileges on Discovery. The functions above are the entire surface.
revoke all on function p2.claim_events(text, integer) from public;
revoke all on function p2.ack_event(text, uuid, text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'p2_app') then
    grant usage on schema p2 to p2_app;
    grant execute on function p2.claim_events(text, integer) to p2_app;
    grant execute on function p2.ack_event(text, uuid, text, text) to p2_app;
    -- The consumer reads its own deliveries and its watermark. It NEVER
    -- writes the inbox or the watermark directly: claiming and acknowledgement
    -- go through the two functions above, so dedup and watermark invariants
    -- cannot be bypassed. No DELETE anywhere: cases are archived, never
    -- removed, and inbox rows are retained dead letters.
    grant select on p2.event_inbox, p2.consumer_watermark to p2_app;
    -- The consumer's own domain: cases, snapshots, assessments, audit,
    -- idempotency and reference versions.
    grant insert on p2.case, p2.case_snapshot, p2.case_assessment,
                   p2.audit_event, p2.idempotency_record, p2.reference_version to p2_app;
    grant select on p2.case, p2.case_snapshot, p2.case_assessment,
                   p2.audit_event, p2.idempotency_record, p2.reference_version to p2_app;
    grant update (status, discovery_updated_at, discovery_state_hash, drift_detected_at,
                  latest_sequence, pipeline) on p2.case to p2_app;
  end if;
end;
$$;