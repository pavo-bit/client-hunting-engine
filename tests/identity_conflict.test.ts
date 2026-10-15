/**
 * Identity-conflict review artifacts (migration M7).
 *
 * Invariants under test, all database-backed against the loopback test DB:
 *   - capture is idempotent per (run, source record)
 *   - capture NEVER creates or merges a company (zero merge semantics)
 *   - decisions require actor + reason, are one-shot, and are audited
 *   - unresolved conflicts stay OPEN across reruns (never auto-resolved)
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCompany } from "../lib/intake/import";
import {
  decideIdentityConflict,
  listIdentityConflicts,
  conflictAttribution,
  recordIdentityConflict,
} from "../lib/resolve/conflicts";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/agency_intel_test";
if (!/127\.0\.0\.1|localhost/.test(new URL(DB_URL).hostname)) {
  throw new Error("refusing non-local database");
}
const pool = new Pool({ connectionString: DB_URL, max: 3 });
const ACTOR = "dconf";

async function mkRun(queryText: string): Promise<string> {
  const r = await pool.query(
    `insert into public.discovery_run (adapter_id, adapter_version, status, query_text, created_by, finished_at)
     values ('gleif-lei', '1', 'ok', $1, $2, now()) returning id`,
    [queryText, ACTOR],
  );
  return r.rows[0].id as string;
}

async function cleanup(): Promise<void> {
  await pool.query("delete from public.identity_conflict where detail like '%dconf%' or observed_name like 'Dconf%'");
  await pool.query("delete from public.discovery_run where created_by = $1 and query_text like 'dconf-%'", [ACTOR]);
  await pool.query("delete from public.company where domain_norm like 'dconf-%'");
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("identity conflict capture", () => {
  it("records what the source claimed, idempotently, without touching companies", async () => {
    const co = await createCompany(
      pool,
      { name: "Dconf Holder Ltd", domain: "dconf-holder.example", agencyType: "web_development", country: "France", countryCode: "FR" },
      ACTOR,
    );
    const runId = await mkRun("dconf-capture");
    try {
      const first = await recordIdentityConflict(pool, {
        runId,
        sourceRecordId: "dconf-rec-1",
        companyId: co.companyId,
        rule: "registry_scoped",
        detail: "dconf: registry 5493001KJTIIGC8Y1R12 already registered for FR",
        observedName: "Dconf Observed Name",
        observedRegistryId: "5493001KJTIIGC8Y1R12",
        observedCountryCode: "FR",
      });
      expect(first.created).toBe(true);
      expect(first.conflict.status).toBe("pending");
      // Rerun of the same record: no duplicate capture.
      const second = await recordIdentityConflict(pool, {
        runId,
        sourceRecordId: "dconf-rec-1",
        companyId: co.companyId,
        rule: "registry_scoped",
        detail: "dconf: registry 5493001KJTIIGC8Y1R12 already registered for FR",
      });
      expect(second.created).toBe(false);
      expect(second.conflict.id).toBe(first.conflict.id);
      const rows = await listIdentityConflicts(pool, { runId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        observedName: "Dconf Observed Name",
        observedRegistryId: "5493001KJTIIGC8Y1R12",
        observedCountryCode: "FR",
        rule: "registry_scoped",
      });
      // Zero merge semantics: no extra company, nothing merged.
      const c = await pool.connect();
      try {
        const companies = await c.query(
          "select count(*)::int as n, count(*) filter (where merged_into is not null)::int as m from public.company where domain_norm like 'dconf-%'",
        );
        expect(companies.rows[0].n).toBe(1);
        expect(companies.rows[0].m).toBe(0);
      } finally {
        c.release();
      }
    } finally {
      await cleanup();
    }
  });

  it("attributes a captured conflict to the run that captured it (F10)", async () => {
    const co = await createCompany(
      pool,
      { name: "Dconf Attribution Ltd", domain: "dconf-attrib.example", agencyType: "web_development", country: "France", countryCode: "FR" },
      ACTOR,
    );
    const runId = await mkRun("dconf-attribution");
    try {
      const captured = await recordIdentityConflict(pool, {
        runId,
        sourceRecordId: "dconf-attr-1",
        companyId: co.companyId,
        rule: "registry_scoped",
        detail: "dconf: attribution probe",
        observedName: "Dconf Attribution Observed",
        observedRegistryId: "5493001KJTIIGC8Y1R13",
        observedCountryCode: "FR",
      });
      // No actor column on identity_conflict by design; attribution is the
      // capturing run's recorded creator, reachable in one join.
      const attribution = await conflictAttribution(pool, captured.conflict.id);
      expect(attribution.runId).toBe(runId);
      expect(attribution.capturedBy).toBe(ACTOR);
      expect(attribution.runStatus).toBe("ok");
      // An unknown conflict resolves to nulls rather than throwing.
      expect(
        await conflictAttribution(pool, "11111111-2222-4333-8444-555555555555"),
      ).toMatchObject({ capturedBy: null });
    } finally {
      await cleanup();
    }
  });

  it("rejects malformed captures before any write", async () => {
    const co = await createCompany(
      pool,
      { name: "Dconf Validate Ltd", domain: "dconf-validate.example", agencyType: "web_development", country: "France", countryCode: "FR" },
      ACTOR,
    );
    const runId = await mkRun("dconf-validate");
    try {
      await expect(
        recordIdentityConflict(pool, { runId, sourceRecordId: "", companyId: co.companyId, rule: "domain_exact", detail: "dconf x" }),
      ).rejects.toMatchObject({ status: 422, code: "bad_source_record" });
      await expect(
        recordIdentityConflict(pool, { runId, sourceRecordId: "d1", companyId: co.companyId, rule: "registry_scoped", detail: "  " }),
      ).rejects.toMatchObject({ status: 422, code: "bad_detail" });
      await expect(
        recordIdentityConflict(pool, { runId, sourceRecordId: "d2", companyId: co.companyId, rule: "name_exact" as never, detail: "dconf x" }),
      ).rejects.toMatchObject({ status: 422, code: "bad_rule" });
      expect(await listIdentityConflicts(pool, { runId })).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe("identity conflict decisions", () => {
  it("requires actor + reason, is one-shot, and writes an audit row", async () => {
    const co = await createCompany(
      pool,
      { name: "Dconf Decide Ltd", domain: "dconf-decide.example", agencyType: "web_development", country: "France", countryCode: "FR" },
      ACTOR,
    );
    const runId = await mkRun("dconf-decide");
    try {
      const { conflict } = await recordIdentityConflict(pool, {
        runId,
        sourceRecordId: "dconf-dec-1",
        companyId: co.companyId,
        rule: "domain_exact",
        detail: "dconf: domain already registered",
        observedDomain: "dconf-decide.example",
      });
      await expect(
        decideIdentityConflict(pool, conflict.id, { status: "reviewed", actor: "", reason: "dconf checked" }),
      ).rejects.toMatchObject({ status: 422, code: "actor_required" });
      await expect(
        decideIdentityConflict(pool, conflict.id, { status: "reviewed", actor: ACTOR, reason: "   " }),
      ).rejects.toMatchObject({ status: 422, code: "reason_required" });
      await expect(
        decideIdentityConflict(pool, conflict.id, { status: "pending" as never, actor: ACTOR, reason: "nope" }),
      ).rejects.toMatchObject({ status: 422, code: "bad_status" });
      // Still OPEN after the refused attempts - nothing auto-resolved.
      expect((await listIdentityConflicts(pool, { runId }))[0].status).toBe("pending");

      const done = await decideIdentityConflict(pool, conflict.id, {
        status: "reviewed",
        actor: ACTOR,
        reason: "dconf: distinct entity, registry re-issued to the holder",
      });
      expect(done.status).toBe("reviewed");
      await expect(
        decideIdentityConflict(pool, conflict.id, { status: "deferred", actor: ACTOR, reason: "dconf second look" }),
      ).rejects.toMatchObject({ status: 409, code: "already_decided" });
      await expect(
        decideIdentityConflict(pool, "00000000-0000-4000-8000-000000000000", {
          status: "reviewed",
          actor: ACTOR,
          reason: "dconf missing",
        }),
      ).rejects.toMatchObject({ status: 404, code: "conflict_not_found" });
      const c = await pool.connect();
      try {
        const audit = await c.query(
          "select actor, transition_from, transition_to, reason from public.audit_log where entity_type = 'identity_conflict' and entity_id = $1",
          [conflict.id],
        );
        expect(audit.rows).toHaveLength(1);
        expect(audit.rows[0]).toMatchObject({
          actor: ACTOR,
          transition_from: "pending",
          transition_to: "reviewed",
        });
        // Decision never merged anything.
        const merged = await c.query(
          "select count(*)::int as n from public.company where merged_into is not null and domain_norm like 'dconf-%'",
        );
        expect(merged.rows[0].n).toBe(0);
      } finally {
        c.release();
      }
    } finally {
      await cleanup();
    }
  });
});