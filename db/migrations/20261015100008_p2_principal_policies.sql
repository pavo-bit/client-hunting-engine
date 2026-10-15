-- Migration M16: RLS policies for the Phase 2 principal's own domain (Part 1).
--
-- Forward-only. Root cause, found by the permission tests: RLS is enabled on
-- every p2 table (defense in depth, like the Discovery tables), but enabled
-- RLS with NO policy means deny-all — even where M10 granted the p2_app role
-- INSERT/SELECT/UPDATE. The app server connects as owner (which bypasses RLS),
-- so nothing broke there; but the grants M10 gave p2_app were unusable, and
-- the permission suite proved it (`row-level security policy for table
-- "case"` on a granted INSERT).
--
-- These policies let p2_app use exactly what M10 granted, nothing more:
-- full row access on its six domain tables, SELECT-only on its inbox rows and
-- watermark (delivery inspection; settlement stays inside ack_event). DELETE
-- is still denied everywhere: no DELETE was ever granted, and grants — not
-- policies — decide that. Other roles (notably noaccess) match no policy and
-- stay denied by both RLS and grants.
create policy p2_case_p2app on p2.case for all to p2_app using (true) with check (true);
create policy p2_case_snapshot_p2app on p2.case_snapshot for all to p2_app using (true) with check (true);
create policy p2_case_assessment_p2app on p2.case_assessment for all to p2_app using (true) with check (true);
create policy p2_audit_event_p2app on p2.audit_event for all to p2_app using (true) with check (true);
create policy p2_idempotency_record_p2app on p2.idempotency_record for all to p2_app using (true) with check (true);
create policy p2_reference_version_p2app on p2.reference_version for all to p2_app using (true) with check (true);
create policy p2_event_inbox_p2app_select on p2.event_inbox for select to p2_app using (true);
create policy p2_consumer_watermark_p2app_select on p2.consumer_watermark for select to p2_app using (true);