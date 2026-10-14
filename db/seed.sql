-- T-002 development seed: SYNTHETIC FICTIONAL DATA ONLY.
-- No real agencies, no real evidence, no external requests, no outreach.
-- Rerun-safe: every INSERT uses ON CONFLICT DO NOTHING with fixed UUIDs.
--
-- Demonstrates: 3 agency types x 3 countries, provenance chain,
-- observed/corroborated/inferred/assumed claims, supporting + contradicting
-- evidence, hypothesis with validation questions, capability match + project
-- proposal with ranges, provisional score breakdown, review + manual outcome.
--
-- R-03: seed must stay compatible with the CURRENT schema. The hypothesis is
-- seeded as 'needs_review' (T-008 lifecycle; migration 20261013000011 mapped
-- evidenced -> needs_review). Re-running is safe: every INSERT is
-- ON CONFLICT DO NOTHING with fixed UUIDs, and the whole file is sent as one
-- simple-query batch, so it is atomic - any error leaves the database untouched.

-- ---------------------------------------------------------------- companies
insert into public.company
  (id, name, domain_norm, registry_id, agency_type, country, country_code, region,
   website_url, discovery_status)
values
  ('11111111-1111-4000-8000-111111111111', 'Acme Webworks', 'acme-webworks.example',
   null, 'web_development', 'United States', 'US', 'California',
   'https://acme-webworks.example', 'qualified'),
  ('22222222-2222-4000-8000-222222222222', 'Globex Digital Studio', 'globex-digital.example',
   null, 'custom_software', 'Germany', 'DE', 'Berlin',
   'https://globex-digital.example', 'resolved'),
  ('33333333-3333-4000-8000-333333333333', 'Initech Mobile Lab', 'initech-mobile.example',
   null, 'mobile_app', 'Singapore', 'SG', null,
   'https://initech-mobile.example', 'candidate')
on conflict (id) do nothing;

-- ------------------------------------------------------- discovery records
insert into public.discovery_record
  (id, company_id, source_key, collection_method, retrieval_status, query_text,
   adapter_version, note)
values
  ('a1a1a1a1-a1a1-4000-8000-a1a1a1a1a1a1', '11111111-1111-4000-8000-111111111111',
   null, 'manual', 'ok', null, null, 'SYNTHETIC: operator direct entry (FR-001)'),
  ('a2a2a2a2-a2a2-4000-8000-a2a2a2a2a2a2', '11111111-1111-4000-8000-111111111111',
   'agency-directory', 'api', 'ok', 'web agencies, US', 'agency-directory/0.1',
   'SYNTHETIC: agency-directory listing hit'),
  ('a3a3a3a3-a3a3-4000-8000-a3a3a3a3a3a3', '22222222-2222-4000-8000-222222222222',
   null, 'import', 'ok', null, null, 'SYNTHETIC: CSV import row 12 (FR-002)'),
  ('a4a4a4a4-a4a4-4000-8000-a4a4a4a4a4a4', '33333333-3333-4000-8000-333333333333',
   null, 'manual', 'ok', null, null, 'SYNTHETIC: operator direct entry (FR-001)')
on conflict (id) do nothing;

-- ------------------------------------------------------------ research runs
insert into public.research_run (id, company_id, status, finished_at, note)
values
  ('b1b1b1b1-b1b1-4000-8000-b1b1b1b1b1b1', '11111111-1111-4000-8000-111111111111',
   'ok', now(), 'SYNTHETIC: completed research pass'),
  ('b2b2b2b2-b2b2-4000-8000-b2b2b2b2b2b2', '22222222-2222-4000-8000-222222222222',
   'failed', now(), 'SYNTHETIC: blocked by rate limit; see failure_log')
on conflict (id) do nothing;

-- --------------------------------------------------------------- snapshots
-- Metadata only (+ short excerpt). sha256 values are SYNTHETIC placeholders.
insert into public.snapshot
  (id, company_id, source_key, research_run_id, url, sha256, store_ref,
   content_excerpt, retention_class)
values
  ('c1c1c1c1-c1c1-4000-8000-c1c1c1c1c1c1', '11111111-1111-4000-8000-111111111111',
   'agency-directory', 'b1b1b1b1-b1b1-4000-8000-b1b1b1b1b1b1',
   'https://directory.example/listings/acme-webworks',
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   'local://snapshots/c1c1', 'SYNTHETIC EXCERPT: Acme Webworks, Los Angeles CA, web development.',
   'directory'),
  ('c2c2c2c2-c2c2-4000-8000-c2c2c2c2c2c2', '11111111-1111-4000-8000-111111111111',
   'company-site', 'b1b1b1b1-b1b1-4000-8000-b1b1b1b1b1b1',
   'https://acme-webworks.example/services',
   'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
   'local://snapshots/c2c2', 'SYNTHETIC EXCERPT: services page lists web builds, support email, client login link.',
   'page')
on conflict (id) do nothing;

-- ------------------------------------------------------------------ claims
insert into public.claim
  (id, company_id, snapshot_id, claim_text, claim_status,
   source_reliability, info_credibility, observed_at, expires_at)
values
  ('d1d1d1d1-d1d1-4000-8000-d1d1d1d1d1d1', '11111111-1111-4000-8000-111111111111',
   'c2c2c2c2-c2c2-4000-8000-c2c2c2c2c2c2',
   'SYNTHETIC OBSERVED: services page lists web builds and a support email.',
   'observed', 'B', 2, now(), now() + interval '90 days'),
  ('d2d2d2d2-d2d2-4000-8000-d2d2d2d2d2d2', '11111111-1111-4000-8000-111111111111',
   'c1c1c1c1-c1c1-4000-8000-c1c1c1c1c1c1',
   'SYNTHETIC CORROBORATED: directory and site agree the agency is in Los Angeles, CA.',
   'corroborated', 'B', 1, now(), now() + interval '180 days'),
  ('d3d3d3d3-d3d3-4000-8000-d3d3d3d3d3d3', '11111111-1111-4000-8000-111111111111',
   'c2c2c2c2-c2c2-4000-8000-c2c2c2c2c2c2',
   'SYNTHETIC INFERENCE: services page wording suggests project intake is email-based.',
   'inferred', 'C', 3, now(), now() + interval '60 days'),
  ('d4d4d4d4-d4d4-4000-8000-d4d4d4d4d4d4', '11111111-1111-4000-8000-111111111111',
   'c2c2c2c2-c2c2-4000-8000-c2c2c2c2c2c2',
   'SYNTHETIC ASSUMPTION (UNCONFIRMED): internal QA may be manual. Must be validated with the agency; never stated as fact.',
   'assumed', 'D', 4, now(), now() + interval '30 days'),
  ('d5d5d5d5-d5d5-4000-8000-d5d5d5d5d5d5', '11111111-1111-4000-8000-111111111111',
   'c2c2c2c2-c2c2-4000-8000-c2c2c2c2c2c2',
   'SYNTHETIC OBSERVED (CONTRADICTS portal hypothesis): site already links a client login page.',
   'observed', 'B', 2, now(), now() + interval '90 days')
on conflict (id) do nothing;

-- --------------------------------------------------------------- hypothesis
-- R-03: the current lifecycle is generated / needs_review / deferred /
-- rejected / validated / superseded. This row used to say 'evidenced', which
-- T-008 removed; migration 20261013000011 remapped evidenced -> needs_review
-- (line 17), and that mapping is exactly right for this demo record: it has
-- three supporting claims AND an unresolved contradicting claim (d5), and its
-- rationale states human validation is still required. So the canonical status
-- is 'needs_review' - not 'generated' (it has evidence), and not 'validated'
-- (explicitly unconfirmed). Same decision the migration already applied to
-- this exact row, so re-seeding reproduces the state a migrated database has.
insert into public.hypothesis
  (id, company_id, title, opportunity_category, status, confidence_rationale)
values
  ('e1e1e1e1-e1e1-4000-8000-e1e1e1e1e1e1', '11111111-1111-4000-8000-111111111111',
   'SYNTHETIC: client onboarding portal to replace email-based intake',
   'portals_dashboards', 'needs_review',
   'SYNTHETIC: email-intake inference is unconfirmed; existing login link may already cover this. Human-led validation required before validated.')
on conflict (id) do nothing;

-- R-03: T-008 migration 20261013000012 made the key polarity-aware
-- (hypothesis_id, claim_id, polarity) so one claim can be linked under both
-- headings. The old ON CONFLICT (hypothesis_id, claim_id) no longer matches any
-- unique constraint. The conflict target must mirror the current primary key.
insert into public.hypothesis_evidence (hypothesis_id, claim_id, polarity, note)
values
  ('e1e1e1e1-e1e1-4000-8000-e1e1e1e1e1e1', 'd1d1d1d1-d1d1-4000-8000-d1d1d1d1d1d1', 'supports', 'SYNTHETIC'),
  ('e1e1e1e1-e1e1-4000-8000-e1e1e1e1e1e1', 'd2d2d2d2-d2d2-4000-8000-d2d2d2d2d2d2', 'supports', 'SYNTHETIC'),
  ('e1e1e1e1-e1e1-4000-8000-e1e1e1e1e1e1', 'd3d3d3d3-d3d3-4000-8000-d3d3d3d3d3d3', 'supports', 'SYNTHETIC'),
  ('e1e1e1e1-e1e1-4000-8000-e1e1e1e1e1e1', 'd5d5d5d5-d5d5-4000-8000-d5d5d5d5d5d5', 'contradicts', 'SYNTHETIC: must be acknowledged in review')
on conflict (hypothesis_id, claim_id, polarity) do nothing;

-- ------------------------------------------------- capabilities + project
-- PLACEHOLDER catalog rows (D-004 open): never present as proven offerings.
insert into public.capability (key, name, description, entry_criteria, owner, is_placeholder)
values
  ('web-portal-build', 'SYNTHETIC PLACEHOLDER: client portal builds',
   'SYNTHETIC: placeholder capability pending D-004.', 'TBD', 'TBD', true),
  ('qa-automation', 'SYNTHETIC PLACEHOLDER: QA automation',
   'SYNTHETIC: placeholder capability pending D-004.', 'TBD', 'TBD', true)
on conflict (key) do nothing;

insert into public.project_option
  (id, hypothesis_id, title, scope_in, scope_out, milestones,
   effort_lo_days, effort_hi_days, feasibility, capability_fit,
   assumptions, impact_note, cost_low, cost_high, cost_currency,
   dependencies, validation_questions)
values
  ('f1f1f1f1-f1f1-4000-8000-f1f1f1f1f1f1', 'e1e1e1e1-e1e1-4000-8000-e1e1e1e1e1e1',
   'SYNTHETIC: onboarding portal discovery + pilot',
   'SYNTHETIC: intake form, status page, pilot with one team.',
   'SYNTHETIC: billing migration, mobile apps.',
   'SYNTHETIC: M1 discovery, M2 pilot, M3 handover.',
   20, 40, 'medium', 'SYNTHETIC: matches web-portal-build placeholder.',
   'SYNTHETIC ASSUMPTIONS: agency confirms email intake; pilot team available; content provided by agency.',
   'SYNTHETIC: impact range TBD after validation; no revenue promised.',
   8000, 15000, 'USD',
   'SYNTHETIC: agency provides brand assets and a pilot contact.',
   'SYNTHETIC: How do you handle intake today? What does the existing login page cover? Who would pilot this?')
on conflict (id) do nothing;

insert into public.project_capability (project_option_id, capability_key)
values ('f1f1f1f1-f1f1-4000-8000-f1f1f1f1f1f1', 'web-portal-build')
on conflict (project_option_id, capability_key) do nothing;

-- ------------------------------------------------------------------ scoring
-- Provisional breakdown (D-006): 24+15+14+10+6-5 = 64 -> band B (generated).
insert into public.score_run
  (id, hypothesis_id, weight_version, fit, evidence, opportunity, feasibility,
   timing, deductions, gates_passed, gate_notes, explanation)
values
  ('0a0a0a0a-0a0a-4000-8000-0a0a0a0a0a0a', 'e1e1e1e1-e1e1-4000-8000-e1e1e1e1e1e1',
   'v0.1-PROVISIONAL', 24, 15, 14, 10, 6, 5, true,
   'SYNTHETIC: eligibility + evidence-sufficiency + feasibility gates hold; contradiction d5 acknowledged pending review.',
   '{"version": "v0.1-PROVISIONAL", "fit": 24, "evidence": 15, "opportunity": 14, "feasibility": 10, "timing": 6, "deductions": 5, "synthetic": true}')
on conflict (id) do nothing;

-- ------------------------------------------------------- brief + outreach
insert into public.brief
  (ref, company_id, hypothesis_id, score_run_id, frozen_inputs_hash, markdown,
   status, reviewer)
values
  ('BR-2026-001', '11111111-1111-4000-8000-111111111111',
   'e1e1e1e1-e1e1-4000-8000-e1e1e1e1e1e1', '0a0a0a0a-0a0a-4000-8000-0a0a0a0a0a0a',
   'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
   'SYNTHETIC BRIEF: Acme Webworks onboarding-portal hypothesis with supporting (d1-d3) and contradicting (d5) evidence; assumptions labeled; validation questions attached.',
   'in_review', 'operator')
on conflict (ref) do nothing;

insert into public.outreach_draft (id, brief_ref, channel, subject, body)
values
  ('b00b00b0-00b0-4000-8000-b00b00b00b00', 'BR-2026-001', 'email',
   'SYNTHETIC DRAFT subject (human-send-only)',
   'SYNTHETIC DRAFT body. Human must inspect, edit, and send manually. No system delivery exists.')
on conflict (id) do nothing;

-- ------------------------------------------------- outcome + audit + failure
insert into public.outcome_log
  (id, brief_ref, sent_at_manual, channel, outcome, rejection_code, note, recorded_by)
values
  ('c00c00c0-00c0-4000-8000-c00c00c00c00', 'BR-2026-001', current_date - 1,
   'email', 'replied', null, 'SYNTHETIC: manual log of a human-sent email and reply.', 'operator')
on conflict (id) do nothing;

insert into public.audit_log
  (id, entity_type, entity_id, actor, transition_from, transition_to, reason)
values
  ('d00d00d0-00d0-4000-8000-d00d00d00d00', 'company',
   '11111111-1111-4000-8000-111111111111', 'operator', 'candidate', 'qualified',
   'SYNTHETIC: manual qualification after evidence review'),
  ('d00d00d0-00d0-4000-8000-d00d00d00d01', 'hypothesis',
   'e1e1e1e1-e1e1-4000-8000-e1e1e1e1e1e1', 'operator', 'generated', 'needs_review',
   'SYNTHETIC: supporting evidence attached; contradiction d5 flagged')
on conflict (id) do nothing;

insert into public.failure_log (id, entity_type, entity_id, cause_class, detail)
values
  ('e00e00e0-00e0-4000-8000-e00e00e00e00', 'research_run',
   'b2b2b2b2-b2b2-4000-8000-b2b2b2b2b2b2', 'rate_limited',
   'SYNTHETIC: directory API quota hit for Globex; manual fallback logged.')
on conflict (id) do nothing;
