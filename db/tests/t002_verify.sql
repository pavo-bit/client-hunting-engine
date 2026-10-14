-- T-002 verification suite. Run against a FRESH LOCAL database after
-- node scripts/db.mjs migrate + seed (target dev). Every DO block raises on
-- failure; the trailing SELECTs emit evidence rows. NOT a substitute for
-- application-level tests (T-003+); it covers schema + seed + policy behavior.

-- 1. Seed counts -----------------------------------------------------------
do $$
declare
  n_company int; n_source_category int; n_source_connector int; n_claim int;
  n_sup int; n_con int; s_total int; s_band char(1);
begin
  select count(*) into n_company from public.company;
  if n_company <> 3 then raise exception 'company count %, want 3', n_company; end if;

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

  select count(*) into n_claim from public.claim;
  if n_claim <> 5 then raise exception 'claim count %, want 5', n_claim; end if;

  select count(*) into n_sup from public.hypothesis_evidence where polarity = 'supports';
  select count(*) into n_con from public.hypothesis_evidence where polarity = 'contradicts';
  if n_sup <> 3 or n_con <> 1 then
    raise exception 'hypothesis_evidence supports=% contradicts=%, want 3/1', n_sup, n_con;
  end if;

  select total, band into s_total, s_band from public.score_run
    where id = '0a0a0a0a-0a0a-4000-8000-0a0a0a0a0a0a';
  if s_total <> 64 or s_band <> 'B' then
    raise exception 'score total=% band=%, want 64/B', s_total, s_band;
  end if;
raise notice 'source categories=%, connectors=%', n_source_category, n_source_connector;
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

-- Evidence outputs ----------------------------------------------------------
-- The source evidence line keeps categories and connectors as separate
-- columns so the additional connector rows remain visible in the output.
select 'counts' as check,
  (select count(*) from public.company) as companies,
  (select count(*) filter (where kind = 'category') from public.source) as source_categories,
  (select count(*) filter (where kind = 'connector') from public.source) as source_connectors,
  (select count(*) from public.source) as source_rows_total,
  (select count(*) from public.claim) as claims;
select key, category, kind, enabled, reliability_prior from public.source order by kind, key;
select ref, status, reviewer from public.brief;
select total, band, gates_passed, weight_version from public.score_run;
select polarity, count(*) from public.hypothesis_evidence group by polarity;
select entity_type, transition_from, transition_to from public.audit_log order by created_at;
