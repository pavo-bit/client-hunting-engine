-- T-004 migration 8/8: canonical resolution & dedup (additive; T-002/T-003 untouched).
--
-- IDENTITY RULES (deterministic precedence, documented in DATA_MODEL_AND_EVIDENCE.md):
--   1. Jurisdiction-scoped registry: same country_code + same registry_id.
--      Identical registry IDs under DIFFERENT jurisdictions never match.
--   2. Exact normalized domain (lowercase, no www., has dot).
--   3. Verified aliases (company_alias) from prior human-reviewed merges.
--   4. Exact normalized names are supporting evidence ONLY -> review queue.
-- NEVER auto-merge on names alone. Conflicting authoritative registry IDs
-- (both present, different, jurisdictions not provably different) block
-- automatic merging and force human review.
--
-- Canonical <=> merged_into IS NULL. Losers become 'archived' + merged_into,
-- keep their rows (history preserved), and gain alias records.

-- 1. Merge pointer on company (reuses 'archived' status; no new vocab).
alter table public.company
  add column merged_into uuid references public.company (id) on delete restrict;

alter table public.company
  add constraint company_merge_state check (
    (merged_into is null) or
    (merged_into is not null and discovery_status = 'archived')
  );

alter table public.company
  add constraint company_no_self_merge check (merged_into is distinct from id);

create index company_merged_into_idx on public.company (merged_into)
  where merged_into is not null;

-- 2. Duplicate candidates (persisted; regenerate is idempotent).
create table public.match_candidate (
  id uuid primary key default gen_random_uuid(),
  company_a uuid not null references public.company (id) on delete cascade,
  company_b uuid not null references public.company (id) on delete cascade,
  rule text not null check (rule in (
    'domain_exact', 'registry_scoped', 'alias', 'name_exact'
  )),
  detail text not null check (char_length(detail) between 1 and 2000),
  conflicting_registry boolean not null default false,
  status text not null default 'pending' check (status in (
    'pending', 'accepted', 'rejected', 'deferred'
  )),
  decided_by text,
  decided_at timestamptz,
  decision_reason text,
  created_at timestamptz not null default now(),
  constraint match_candidate_distinct check (company_a <> company_b),
  constraint match_candidate_decision_needs_actor check (
    (status = 'pending') or
    (status <> 'pending' and decided_by is not null and decided_at is not null)
  )
);

-- One live row per unordered pair + rule (history preserved, regen is a no-op).
create unique index match_candidate_pair_uidx on public.match_candidate
  (least(company_a, company_b), greatest(company_a, company_b), rule);

create index match_candidate_status_idx on public.match_candidate (status);

-- 3. Merge function: transactional, ordered locking, conflict guards.
--    Call inside the caller's transaction. Raises:
--      'merge_same_record' | 'merge_state' (already merged / bad state)
--      'registry_conflict' (unless p_allow_conflict) | 'alias_collision'.
create or replace function public.resolve_merge_company(
  p_loser uuid,
  p_winner uuid,
  p_actor text,
  p_reason text,
  p_allow_conflict boolean default false
)
returns text
language plpgsql
as $$
declare
  v_loser public.company%rowtype;
  v_winner public.company%rowtype;
  v_moved integer := 0;
  v_n integer;
  v_conflict boolean := false;
begin
  if p_loser = p_winner then
    raise exception 'merge_same_record: %', p_loser;
  end if;

  -- Ordered locking: deadlock-safe under concurrent merges.
  select * into v_loser from public.company where id = p_loser for update;
  select * into v_winner from public.company where id = p_winner for update;
  if v_loser.id is null or v_winner.id is null then
    raise exception 'merge_state: record missing';
  end if;
  if v_loser.merged_into is not null then
    raise exception 'merge_state: loser % already merged', p_loser;
  end if;
  if v_winner.merged_into is not null then
    raise exception 'merge_state: winner % is itself merged', p_winner;
  end if;

  -- Registry conflict guard: both present, different, jurisdictions not
  -- provably different (equal or unknown) => human review required.
  if v_loser.registry_id is not null and v_winner.registry_id is not null
     and v_loser.registry_id <> v_winner.registry_id
     and not (v_loser.country_code is not null
              and v_winner.country_code is not null
              and v_loser.country_code <> v_winner.country_code) then
    v_conflict := true;
    if not p_allow_conflict then
      raise exception 'registry_conflict: % vs %', v_loser.registry_id, v_winner.registry_id;
    end if;
  end if;

  -- Alias collision guard: loser's identifiers must not already resolve
  -- to a DIFFERENT canonical record.
  if exists (
    select 1 from public.company_alias a
    where a.canonical_company_id <> p_winner
      and ((a.alias_type = 'domain' and a.alias_value = v_loser.domain_norm)
        or (a.alias_type = 'registry_id' and a.alias_value = v_loser.registry_id))
  ) then
    raise exception 'alias_collision: loser identifiers already aliased elsewhere';
  end if;

  -- Repoint child rows to the winner (history preserved, nothing deleted).
  -- NOTE: snapshots are NOT repointed: T-002 snapshot immutability forbids
  -- UPDATEs, and the capture stays attributed to its original record
  -- (reachable via absorbed-record links + merge audit). Claims keep their
  -- snapshot provenance through snapshot_id.
  update public.discovery_record set company_id = p_winner where company_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved + v_n;
  update public.research_run set company_id = p_winner where company_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved + v_n;
  update public.claim set company_id = p_winner where company_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved + v_n;
  update public.hypothesis set company_id = p_winner where company_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved + v_n;
  update public.brief set company_id = p_winner where company_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved + v_n;
  update public.import_row set company_id = p_winner where company_id = p_loser;
  get diagnostics v_n = row_count; v_moved := v_moved + v_n;

  -- Fold loser's alias history into the winner (drop exact duplicates).
  delete from public.company_alias a
  using public.company_alias b
  where a.canonical_company_id = p_loser
    and b.canonical_company_id = p_winner
    and a.alias_type = b.alias_type
    and a.alias_value = b.alias_value;
  update public.company_alias set canonical_company_id = p_winner
  where canonical_company_id = p_loser;

  -- Preserve loser's own identifiers as aliases of the winner.
  if v_loser.domain_norm is not null then
    insert into public.company_alias (canonical_company_id, alias_type, alias_value)
    values (p_winner, 'domain', v_loser.domain_norm)
    on conflict (alias_type, alias_value) do nothing;
  end if;
  if v_loser.registry_id is not null then
    insert into public.company_alias (canonical_company_id, alias_type, alias_value)
    values (p_winner, 'registry_id', v_loser.registry_id)
    on conflict (alias_type, alias_value) do nothing;
  end if;

  update public.company
  set discovery_status = 'archived', merged_into = p_winner
  where id = p_loser;

  insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
  values
    ('company', p_loser::text, p_actor, v_loser.discovery_status, 'archived',
     'merged into ' || p_winner::text || ': ' || p_reason ||
     case when v_conflict then ' [registry conflict overridden by human]' else '' end),
    ('company', p_winner::text, p_actor, v_winner.discovery_status, v_winner.discovery_status,
     'absorbed ' || p_loser::text || ' (' || v_moved::text || ' rows repointed): ' || p_reason);

  return 'merged ' || left(p_loser::text, 8) || ' into ' || left(p_winner::text, 8)
    || ': moved ' || v_moved::text || ' rows';
end;
$$;

-- 4. Same RLS baseline: enabled, no permissive policies, explicit deny.
alter table public.match_candidate enable row level security;
revoke all on public.match_candidate from public;
