-- T-002 verification suite. Run against a FRESH LOCAL database after
-- node scripts/db.mjs migrate + seed (target dev). Every DO block raises on
-- failure; the trailing SELECTs emit evidence rows. NOT a substitute for
-- application-level tests (T-003+); it covers schema + seed + policy behavior.
--
-- SEED VERIFICATION IS IDENTITY-BASED (F17). An earlier version asserted
-- `count(company) = 3` and `count(claim) = 5`, which is only true on a pristine
-- database and therefore reported a false FAILURE on any database holding
-- legitimate live Discovery data (the dev database accumulates real, operator
-- verified companies from manual refreshes - deleting them to satisfy a count
-- would be destroying the product's own evidence). The seed's contract is that
-- its rows EXIST and are UNCHANGED, not that nothing else does. Counts are
-- still reported as evidence, just not asserted.
--
-- TARGET: a MIGRATED AND SEEDED database - `node scripts/db.mjs migrate` then
-- `node scripts/db.mjs seed`, then `node scripts/db.mjs verify` (dev by
-- default). The test database is migrate-only by design (suites build their own
-- fixtures and must not inherit seed rows), so it is not a verify target. For
-- the pristine end-to-end proof use an isolated scratch database:
--   $env:DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_scratch'
--   node scripts/db.mjs bootstrap; node scripts/db.mjs migrate
--   node scripts/db.mjs seed;   node scripts/db.mjs verify
-- db.mjs loads .env only for variables that are unset, so an explicit
-- DATABASE_URL override targets scratch without touching dev.

-- 1. Seed identity ----------------------------------------------------------
do $$
declare
  n_company int; n_source_category int; n_source_connector int; n_claim int;
  n_sup int; n_con int; s_total int; s_band char(1);
begin
  -- Every seeded company exists with its seeded identity and domain. Extra
  -- companies are legitimate accumulated data, not a failure.
  if not exists (select 1 from public.company
                 where id = '11111111-1111-4000-8000-111111111111'
                   and domain_norm = 'acme-webworks.example') then
    raise exception 'seed company Acme Webworks missing or altered'; end if;
  if not exists (select 1 from public.company
                 where id = '22222222-2222-4000-8000-222222222222'
                   and domain_norm = 'globex-digital.example') then
    raise exception 'seed company Globex Digital Studio missing or altered'; end if;
  if not exists (select 1 from public.company
                 where id = '33333333-3333-4000-8000-333333333333'
                   and domain_norm = 'initech-mobile.example') then
    raise exception 'seed company Initech Mobile Lab missing or altered'; end if;
  -- At least the seed exists (catches an unseeded database immediately).
  if (select count(*) from public.company
      where id in ('11111111-1111-4000-8000-111111111111',
                   '22222222-2222-4000-8000-222222222222',
                   '33333333-3333-4000-8000-333333333333')) <> 3 then
    raise exception 'seed companies are incomplete'; end if;
  -- Domain uniqueness holds for the WHOLE table (accumulated data included):
  -- one business, one canonical domain, forever. NULL domains are excluded -
  -- they are legitimate, not duplicates: registry sources (GLEIF) identify
  -- companies by LEI and carry no domain, so `count(*)` must not be compared
  -- against `count(distinct domain_norm)`.
  if (select count(*) from public.company where domain_norm is not null) <>
     (select count(distinct domain_norm) from public.company) then
    raise exception 'duplicate domain_norm exists'; end if;
  select count(*) into n_company from public.company;

  -- R-02 correction: the locked invariant is exactly 12 CATEGORY rows
  -- (S-01..S-12, locked by migration 2). Migration 6 (T-006) additionally
  -- registers live CONNECTOR rows (e.g. gleif-api) as instance rows under a
  -- category, and migration 7 split `kind` so both can be counted precisely.
  -- Counting raw rows conflated the two and reported 13. Connector rows are
  -- counted and reported below, never ignored.
  select count(*) filter (where kind = 'category') into n_source_category
    from public.source;
  if n_source_category <> 12 then
    raise exception 'source CATEGORY count %, want 12', n_source_category;
  end if;

  select count(*) filter (where kind = 'connector') into n_source_connector
    from public.source;

  -- The five seeded claims exist, still attached to the seeded company and
  -- still carrying their seeded statuses (history is not silently rewritten).
  if (select count(*) from public.claim where id in (
        'd1d1d1d1-d1d1-4000-8000-d1d1d1d1d1d1',
        'd2d2d2d2-d2d2-4000-8000-d2d2d2d2d2d2',
        'd3d3d3d3-d3d3-4000-8000-d3d3d3d3d3d3',
        'd4d4d4d4-d4d4-4000-8000-d4d4d4d4d4d4',
        'd5d5d5d5-d5d5-4000-8000-d5d5d5d5d5d5')
      and company_id = '11111111-1111-4000-8000-111111111111') <> 5 then
    raise exception 'seed claims missing, re-attached, or altered'; end if;
  if not exists (select 1 from public.claim
                 where id = 'd5d5d5d5-d5d5-4000-8000-d5d5d5d5d5d5'
                   and claim_status = 'observed') then
    raise exception 'seed contradicting claim d5 was rewritten'; end if;
  select count(*) into n_claim from public.claim;

  -- The seeded evidence links exist in both polarities (3 supports, 1
  -- contradicts) by identity; later claims may add more links legitimately.
  select count(*) into n_sup from public.hypothesis_evidence
    where hypothesis_id = 'e1e1e1e1-e1e1-4000-8000-e1e1e1e1e1e1'
      and claim_id in ('d1d1d1d1-d1d1-4000-8000-d1d1d1d1d1d1',
                       'd2d2d2d2-d2d2-4000-8000-d2d2d2d2d2d2',
                       'd3d3d3d3-d3d3-4000-8000-d3d3d3d3d3d3')
      and polarity = 'supports';
  select count(*) into n_con from public.hypothesis_evidence
    where hypothesis_id = 'e1e1e1e1-e1e1-4000-8000-e1e1e1e1e1e1'
      and claim_id = 'd5d5d5d5-d5d5-4000-8000-d5d5d5d5d5d5'
      and polarity = 'contradicts';
  if n_sup <> 3 or n_con <> 1 then
    raise exception 'seed hypothesis_evidence links supports=% contradicts=%, want 3/1',
      n_sup, n_con;
  end if;

  -- Accumulated Discovery data must keep pointing at live businesses.
  if exists (
    select 1 from public.opportunity o
    where o.company_id is not null
      and not exists (select 1 from public.company c where c.id = o.company_id)
  ) then raise exception 'opportunity references a missing company'; end if;
  if exists (
    select 1 from public.opportunity_eligibility e
    where not exists (select 1 from public.opportunity o where o.id = e.opportunity_id)
  ) then raise exception 'eligibility row without its opportunity'; end if;

  select total, band into s_total, s_band from public.score_run
    where id = '0a0a0a0a-0a0a-4000-8000-0a0a0a0a0a0a';
  if s_total <> 64 or s_band <> 'B' then
    raise exception 'score total=% band=%, want 64/B', s_total, s_band;
  end if;
raise notice 'seed verified by identity; companies=% (seed 3 + accumulated), claims=% (seed 5 + accumulated), source categories=%, connectors=%',
  n_company, n_claim, n_source_category, n_source_connector;
end;
$$;

-- 1b. Source registry invariants (R-02 regression) ---------------------------
-- Proves, against the live registry:
--   (a) exactly 12 category rows exist;
--   (b) every category row maps to one of the 12 approved S-codes;
--   (c) every connector row hangs off an approved category (no orphan code);
--   (d) the T-006 GLEIF connector is still registered, enabled and typed;
--   (e) registering an ADDITIONAL connector does not change the category count.
-- The probe row is removed again, so the registry is left exactly as found.
do $$
declare
  n_before int; c_before int; n_after int; c_after int;
  v_probe text := 'r02-probe-connector';
begin
  -- c_* = category rows, n_* = total source rows (categories + connectors).
  select count(*) filter (where kind = 'category'), count(*)
    into c_before, n_before from public.source;

  -- (a)
  if c_before <> 12 then
    raise exception 'source CATEGORY count %, want 12', c_before;
  end if;

  -- (b) categories are exactly the 12 approved codes
  if exists (
    select 1 from public.source
    where kind = 'category' and category not in (
      'S-01','S-02','S-03','S-04','S-05','S-06',
      'S-07','S-08','S-09','S-10','S-11','S-12')
  ) then raise exception 'category row with unapproved source code'; end if;

  -- (c) connectors sit under an approved category
  if exists (
    select 1 from public.source
    where kind = 'connector' and category not in (
      'S-01','S-02','S-03','S-04','S-05','S-06',
      'S-07','S-08','S-09','S-10','S-11','S-12')
  ) then raise exception 'connector row with unapproved source code'; end if;

  -- (d) the T-006 live connector is still present, enabled and correctly typed
  if not exists (
    select 1 from public.source
    where key = 'gleif-api' and kind = 'connector'
      and category = 'S-02' and enabled = true
  ) then raise exception 'gleif-api connector row missing or mis-typed'; end if;

  -- (e) adding a connector leaves the category count untouched
  delete from public.source where key = v_probe;
  insert into public.source (key, category, platform, reliability_prior, enabled, kind)
  values (v_probe, 'S-05', 'R-02 probe connector', 'C', false, 'connector');

  select count(*) filter (where kind = 'category'), count(*)
    into c_after, n_after from public.source;

  if c_after <> c_before then
    raise exception 'adding a connector changed the category count: % -> %', c_before, c_after;
  end if;
  if n_after <> n_before + 1 then
    raise exception 'probe connector was not counted as a source row (% -> %)', n_before, n_after;
  end if;
  if not exists (
    select 1 from public.source where key = v_probe and kind = 'connector'
  ) then raise exception 'probe connector row was hidden'; end if;

  -- leave the registry exactly as found
  delete from public.source where key = v_probe;

  select count(*) filter (where kind = 'category'), count(*)
    into c_after, n_after from public.source;
  if c_after <> c_before or n_after <> n_before then
    raise exception 'probe cleanup failed (categories %->%, rows %->%)',
      c_before, c_after, n_before, n_after;
  end if;
end;
$$;
do $$
begin
  if exists (
    select 1 from public.claim c
    left join public.snapshot s on s.id = c.snapshot_id
    left join public.source so on so.key = s.source_key
    where s.id is null or so.key is null
  ) then raise exception 'orphan claim without snapshot/source'; end if;

  if exists (
    select 1 from public.brief b
    join public.hypothesis h on h.id = b.hypothesis_id
    where b.company_id <> h.company_id
  ) then raise exception 'brief/hypothesis company mismatch'; end if;

  if exists (
    select 1 from public.hypothesis_evidence he
    join public.hypothesis h on h.id = he.hypothesis_id
    join public.claim c on c.id = he.claim_id
    where h.company_id <> c.company_id
  ) then raise exception 'cross-company hypothesis_evidence exists'; end if;

  if (select count(*) from public.outreach_draft where is_human_send_only <> true) <> 0 then
    raise exception 'non-manual outreach draft exists';
  end if;
end;
$$;

-- 3. No delivery path in schema --------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public'
      and (table_name like '%send%' or table_name like '%deliver%'
           or table_name like '%queue%' or table_name like '%smtp%')
  ) then raise exception 'delivery-like table exists'; end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'outreach_draft'
      and column_name in ('sent_at', 'delivery_status', 'sent_status', 'scheduled_at')
  ) then raise exception 'delivery-like column on outreach_draft'; end if;
end;
$$;

-- 4. Negative tests: duplicates + check constraints + immutability ------------
do $$
begin
  -- duplicate domain_norm
  begin
    insert into public.company (name, domain_norm, agency_type, country)
    values ('Dup Test', 'acme-webworks.example', 'web_development', 'United States');
    raise exception 'duplicate domain_norm was accepted';
  exception when unique_violation then null;
  end;

  -- invalid claim_status
  begin
    insert into public.claim
      (company_id, snapshot_id, claim_text, claim_status, source_reliability, info_credibility)
    values ('11111111-1111-4000-8000-111111111111',
            'c1c1c1c1-c1c1-4000-8000-c1c1c1c1c1c1',
            'bad', 'verified-fact', 'B', 2);
    raise exception 'invalid claim_status was accepted';
  exception when check_violation then null;
  end;

  -- invalid source category (Reddit/YouTube have no valid value)
  begin
    insert into public.source (key, category, platform, reliability_prior)
    values ('reddit', 'S-13', 'reddit', 'D');
    raise exception 'out-of-range source category was accepted';
  exception when check_violation then null;
  end;

  -- NOTE: cross-company linkage is covered by the dedicated trigger test below
-- (which inserts a real foreign-company claim first), not here.

  -- snapshot UPDATE still blocked (non-suppression change rejected)
  begin
    update public.snapshot set url = 'https://tampered.example'
    where id = 'c1c1c1c1-c1c1-4000-8000-c1c1c1c1c1c1';
    raise exception 'snapshot update was accepted';
  exception when raise_exception then null;
  end;

  -- snapshot DELETE permitted (migration 8c: cascade/takedown operability).
  -- Probed on a throwaway row so seed provenance stays intact.
  begin
    insert into public.snapshot
      (id, company_id, source_key, url, sha256, retention_class)
    values ('e1e1e1e1-0000-4000-8000-e1e1e1e1e1e1',
            '11111111-1111-4000-8000-111111111111',
            'company-site', 'https://probe.example',
            'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
            'page');
    delete from public.snapshot
    where id = 'e1e1e1e1-0000-4000-8000-e1e1e1e1e1e1';
    if exists (select 1 from public.snapshot
               where id = 'e1e1e1e1-0000-4000-8000-e1e1e1e1e1e1') then
      raise exception 'snapshot delete did not take effect';
    end if;
  end;

  -- audit UPDATE blocked
  begin
    update public.audit_log set reason = 'tampered'
    where id = 'd00d00d0-00d0-4000-8000-d00d00d00d00';
    raise exception 'audit update was accepted';
  exception when raise_exception then null;
  end;
end;
$$;

-- The trigger is covered properly by the dedicated test below,
-- which inserts a real foreign-company claim first and cleans it up.
do $$
declare v_claim uuid;
begin
  insert into public.claim
    (company_id, snapshot_id, claim_text, claim_status, source_reliability, info_credibility)
  values ('22222222-2222-4000-8000-222222222222',
          'c1c1c1c1-c1c1-4000-8000-c1c1c1c1c1c1',
          'SYNTHETIC probe claim for trigger test', 'observed', 'B', 2)
  returning id into v_claim;

  begin
    insert into public.hypothesis_evidence (hypothesis_id, claim_id, polarity)
    values ('e1e1e1e1-e1e1-4000-8000-e1e1e1e1e1e1', v_claim, 'supports');
    raise exception 'cross-company link was accepted';
  exception when raise_exception then
    if sqlerrm not like '%must link one company%' then raise; end if;
  end;

  delete from public.claim where id = v_claim;
end;
$$;

-- 5. RLS + REVOKE: unprivileged roles are denied outright (SQLSTATE 42501).
-- RLS is default-deny AND table grants are revoked from PUBLIC, so direct
-- access raises insufficient_privilege instead of returning an empty set.
-- Either way: no public read, no public write. The app uses the owner
-- connection server-side. `noaccess` is created by scripts/db.mjs bootstrap
-- (LOGIN + CONNECT only, zero table grants).
do $$
begin
  set local role noaccess;
  begin
    perform count(*) from public.company;
    raise exception 'unprivileged role has table access';
  exception when insufficient_privilege then null;
  end;
  reset role;

  set local role noaccess;
  begin
    perform count(*) from public.brief;
    raise exception 'unprivileged role has table access';
  exception when insufficient_privilege then null;
  end;
  reset role;
end;
$$;

-- 6. Discovery structure: tables, constraints, indexes, triggers, RLS ---------
-- F11: the verifier had no knowledge of the Discovery schema added in Prompt
-- 4/5 (M1-M8), so a migration that dropped an index, a trigger or a unique
-- constraint would still have passed. These blocks assert the STRUCTURE only -
-- row counts are business data and belong in the evidence output at the end.
do $$
declare
  v_missing text;
begin
  -- (a) every Discovery table exists.
  select string_agg(t, ', ') into v_missing
  from unnest(array['discovery_run','discovery_run_item','discovery_record',
                    'discovery_coverage_task','opportunity','business_relationship',
                    'opportunity_eligibility','identity_conflict']) as t
  where not exists (select 1 from pg_class c
                    join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = t and c.relkind = 'r');
  if v_missing is not null then
    raise exception 'missing Discovery table(s): %', v_missing; end if;

  -- (b) opportunity identity: per-pipeline unique key (never global), both
  --     pipeline values allowed BY THE SCHEMA (O1 decides whether the app
  --     accepts direct-client rows, not the schema), run link present.
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'opportunity' and c.contype = 'u'
  ) then raise exception 'opportunity has no unique constraint'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'opportunity' and column_name = 'run_id'
  ) then raise exception 'opportunity.run_id (M5 refresh link) is missing'; end if;

  -- (c) eligibility history: monotone versions per opportunity.
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'opportunity_eligibility' and c.contype = 'u'
  ) then raise exception 'opportunity_eligibility has no unique (opportunity, version)'; end if;
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public' and table_name = 'opportunity_eligibility'
      and constraint_type = 'CHECK'
  ) then raise exception 'opportunity_eligibility has no decision/version CHECK'; end if;

  -- (d) identity conflicts are review artifacts: one per run/record/rule and
  --     a status that can be decided by a human.
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'identity_conflict' and c.contype = 'u'
  ) then raise exception 'identity_conflict has no capture-uniqueness constraint'; end if;

  -- (e) coverage task accounting: every documented status, plan order, and the
  --     finished_at CHECK that keeps terminal tasks truthful.
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'discovery_coverage_task'
      and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%skipped_low_yield%'
  ) then raise exception 'discovery_coverage_task status CHECK is missing or changed'; end if;
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'discovery_coverage_task'
      and pg_get_constraintdef(c.oid) like '%finished_at%'
  ) then raise exception 'coverage_task_finished_needs_timestamp CHECK is missing'; end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'discovery_coverage_task_run_idx'
  ) then raise exception 'discovery_coverage_task_run_idx is missing'; end if;

  -- (f) append-only / immutability triggers exist AND are enabled. A disabled
  --     trigger (tgenabled = 'D') would silently allow tampering.
  select string_agg(x.name, ', ') into v_missing
  from unnest(array[
    'audit_log_append_only','snapshot_immutable','claim_assessment_append_only',
    'opportunity_eligibility_append_only']) as x(name)
  where not exists (
    select 1 from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and tg.tgname = x.name
      and not tg.tgisinternal and tg.tgenabled <> 'D'
  );
  if v_missing is not null then
    raise exception 'missing or disabled guard trigger(s): %', v_missing; end if;

  -- (g) RLS is enabled on every Discovery table (default-deny for non-owners).
  select string_agg(t, ', ') into v_missing
  from unnest(array['discovery_run','discovery_run_item','discovery_record',
                    'discovery_coverage_task','opportunity','business_relationship',
                    'opportunity_eligibility','identity_conflict']) as t
  where not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t and c.relrowsecurity
  );
  if v_missing is not null then
    raise exception 'row-level security is NOT enabled on: %', v_missing; end if;

  -- (h) no grants to PUBLIC on the new tables (RLS alone is not the guarantee;
  --     the app connects as owner, the unprivileged role gets nothing).
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('opportunity','opportunity_eligibility','identity_conflict',
                         'discovery_coverage_task','business_relationship')
      and grantee = 'PUBLIC'
  ) then raise exception 'PUBLIC holds a grant on a Discovery table'; end if;

  -- (i) no delivery path smuggled into the Discovery schema.
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public'
      and (table_name like '%send%' or table_name like '%deliver%'
           or table_name like '%queue%' or table_name like '%smtp%')
  ) then raise exception 'delivery-like table exists'; end if;
end;
$$;

-- 7. Unprivileged role is denied on the Discovery tables too ---------------
do $$
declare
  t text;
begin
  foreach t in array array['opportunity','opportunity_eligibility','identity_conflict',
                           'discovery_coverage_task'] loop
    set local role noaccess;
    begin
      execute format('select count(*) from public.%I', t);
      raise exception 'unprivileged role can read %', t;
    exception when insufficient_privilege then null;
    end;
    reset role;
  end loop;
end;
$$;

-- 8. No accumulation cap: the schema cannot express one -------------------
-- A total-opportunity cap would have to appear as a CHECK/DEFAULT limit on
-- insert or as a deletion trigger. There is none, and none may be added: the
-- product requires accumulating every qualifying opportunity forever.
do $$
begin
  if exists (
    select 1 from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'opportunity'
      and not tg.tgisinternal
      and pg_get_triggerdef(tg.oid) ~* '\m(delete|truncate)\m'
  ) then raise exception 'a deletion trigger exists on opportunity (accumulation cap?)'; end if;

  if exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'opportunity'
      and pg_get_constraintdef(c.oid) ~* '(count|max_rows|limit)'
  ) then raise exception 'a count-shaped CHECK exists on opportunity'; end if;
end;
$$;

-- 9. Discovery -> Phase 2 interface: frozen view, outbox, p2 schema ---------
-- Part 1. Structure only (contracts live in docs/DISCOVERY_PHASE2_INTERFACE_SPEC.md
-- and docs/PHASE2_EVENT_CONTRACT.md; row counts are business data and are
-- reported, never asserted).
do $$
declare
  v_missing text;
begin
  -- (a) the frozen view exists with all 42 contract columns.
  if to_regclass('public.v_opportunity_for_qualification_v1') is null then
    raise exception 'frozen qualification view is missing'; end if;
  select string_agg(x.c, ', ') into v_missing
  from unnest(array['opportunity_id','pipeline','opportunity_key','opportunity_status',
    'solution_status','rule_id','first_seen_at','opportunity_updated_at','opportunity_created_at',
    'company_id','company_name','company_domain_norm','company_registry_id','company_registry_type',
    'company_agency_type','company_country','company_country_code','company_merged_into',
    'suppression_reason','eligibility_version','eligibility_decision','eligibility_policy_version',
    'eligibility_gate_reasons','eligibility_decided_by','eligibility_decided_at',
    'evidence_claims_total','evidence_claims_observed','evidence_claims_corroborated',
    'evidence_claims_inferred','evidence_claims_assumed','evidence_claims_disputed',
    'evidence_contradicted_claims','evidence_claims_needing_review',
    'evidence_latest_claim_at','evidence_latest_observed_at',
    'provenance_sources_total','provenance_source_keys','provenance_latest_recorded_at',
    'provenance_records_failed','rule_version','last_event_sequence','last_transition_actor']) as x(c)
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'v_opportunity_for_qualification_v1'
      and column_name = x.c
  );
  if v_missing is not null then
    raise exception 'qualification view is missing contract column(s): %', v_missing; end if;
  -- Counts arrive as integers (M14: an int8 column reaches some drivers as text).
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'v_opportunity_for_qualification_v1'
      and column_name = 'last_event_sequence' and data_type <> 'integer'
  ) then raise exception 'last_event_sequence is not integer'; end if;

  -- (b) the outbox exists, is append-only guarded, and has its identities.
  if to_regclass('public.discovery_outbox') is null then
    raise exception 'discovery_outbox is missing'; end if;
  if not exists (
    select 1 from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'discovery_outbox'
      and tg.tgname = 'discovery_outbox_append_only' and not tg.tgisinternal
      and tg.tgenabled <> 'D'
  ) then raise exception 'discovery_outbox append-only guard is missing or disabled'; end if;
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'discovery_outbox' and c.contype = 'u'
  ) then raise exception 'discovery_outbox has no uniqueness (event_id / opportunity+sequence)'; end if;

  -- (c) the p2 schema holds all 8 foundation tables.
  select string_agg(t, ', ') into v_missing
  from unnest(array['case','case_snapshot','case_assessment','audit_event',
                    'idempotency_record','event_inbox','consumer_watermark',
                    'reference_version']) as t
  where not exists (select 1 from pg_class c
                    join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'p2' and c.relname = t and c.relkind = 'r');
  if v_missing is not null then
    raise exception 'missing p2 table(s): %', v_missing; end if;

  -- (d) the two consumption functions exist with the exact signatures.
  if (select count(*) from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'p2' and p.proname in ('claim_events', 'ack_event')) <> 2 then
    raise exception 'p2 consumption functions are missing'; end if;

  -- (e) the Phase 2 principal exists and holds the approved surface: view
  --     columns (minus attribution), function execution, and its own domain.
  --     Column grants live in column_privileges, not role_table_grants (which
  --     only lists table-level grants) — checking the wrong view reports a
  --     false absence.
  if not exists (select 1 from pg_roles where rolname = 'p2_app') then
    raise exception 'phase-2 role p2_app does not exist (run scripts/db.mjs bootstrap)'; end if;
  if (select count(*) from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'v_opportunity_for_qualification_v1'
        and grantee = 'p2_app' and privilege_type = 'SELECT') <> 41 then
    raise exception 'p2_app does not hold the approved 41 view columns'; end if;
  if exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'v_opportunity_for_qualification_v1'
      and grantee = 'p2_app' and column_name = 'last_transition_actor'
      and privilege_type = 'SELECT'
  ) then raise exception 'p2_app can read operator attribution (must be withheld)'; end if;
  -- No direct access to Discovery tables: any grant at all is a violation.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('opportunity','company','discovery_record','discovery_run',
                         'discovery_outbox','opportunity_eligibility','audit_log')
      and grantee = 'p2_app'
  ) then raise exception 'p2_app holds a grant on a Discovery table'; end if;
end;
$$;

-- 10. Unprivileged role is denied the interface too ------------------------
do $$
begin
  set local role noaccess;
  begin
    perform count(*) from public.v_opportunity_for_qualification_v1;
    raise exception 'unprivileged role can read the qualification view';
  exception when insufficient_privilege then null;
  end;
  reset role;

  set local role noaccess;
  begin
    perform count(*) from public.discovery_outbox;
    raise exception 'unprivileged role can read the outbox';
  exception when insufficient_privilege then null;
  end;
  reset role;
end;
$$;

-- Evidence outputs ----------------------------------------------------------
-- The source evidence line keeps categories and connectors as separate
-- columns so the additional connector rows remain visible in the output.
select 'counts' as check,
  (select count(*) from public.company) as companies,
  (select count(*) filter (where kind = 'category') from public.source) as source_categories,
  (select count(*) filter (where kind = 'connector') from public.source) as source_connectors,
  (select count(*) from public.source) as source_rows_total,
  (select count(*) from public.claim) as claims;
-- Discovery accumulation evidence (reported, never asserted - these are the
-- operator's real data, and the seed contract is identity, not counts).
select 'discovery' as check,
  (select count(*) from public.discovery_run) as runs,
  (select count(*) from public.discovery_run where status = 'running') as runs_running,
  (select count(*) from public.discovery_run_item) as run_items,
  (select count(*) from public.discovery_record) as discovery_records,
  (select count(*) from public.discovery_coverage_task) as coverage_tasks,
  (select count(*) from public.opportunity) as opportunities,
  (select count(*) from public.opportunity where status = 'eligible') as opportunities_eligible,
  (select count(*) from public.opportunity where status = 'promoted') as opportunities_promoted,
  (select count(*) from public.opportunity_eligibility) as eligibility_decisions,
  (select count(*) from public.identity_conflict) as identity_conflicts,
  (select count(*) from public.identity_conflict where status = 'open') as identity_conflicts_open;
select key, category, kind, enabled, reliability_prior from public.source order by kind, key;
select ref, status, reviewer from public.brief;
select total, band, gates_passed, weight_version from public.score_run;
select polarity, count(*) from public.hypothesis_evidence group by polarity;
select entity_type, transition_from, transition_to from public.audit_log order by created_at;
