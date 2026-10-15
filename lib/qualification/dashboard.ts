// Server-side reads for the operator UI (Part 3). Projections only — every
// function here is read-only except where explicitly noted (none write).
// Untrusted content policy: all text rendered by pages comes from these rows
// and React escapes it by default; URLs pass through safeSourceUrl-equivalent
// checks at the page layer (http(s) only, never javascript:).

import type { Pool } from "pg";
import { getPool } from "@/lib/intake/db";

export interface QueueRow {
  case_id: string;
  case_ref: string;
  discovery_opportunity_id: string;
  discovery_opportunity_key: string;
  company_name: string | null;
  pipeline: string;
  status: string;
  suppression_reason: string | null;
  drift_detected_at: string | null;
  latest_outcome: string | null;
  latest_composite: number | null;
  latest_band: string | null;
  latest_version: number | null;
  latest_decided_at: string | null;
  latest_decision: string | null;
  open_tasks: number;
}

export interface QueueFilter {
  pipeline?: string;
  outcome?: string;
  band?: string;
  service?: string;
  drifted?: boolean;
  hasResearch?: boolean;
  /** Default true: suppressed records never appear as pursuit-ready. Pass false to audit them. */
  hideSuppressed?: boolean;
  sort?: "composite" | "updated" | "created" | "confidence";
  limit?: number;
  offset?: number;
}

/** Ranked/pursuit queue: cases with their latest assessment, filterable. */
export async function qualificationQueue(
  pool: Pool = getPool(),
  filter: QueueFilter = {},
): Promise<{ total: number; rows: QueueRow[] }> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.pipeline) {
    params.push(filter.pipeline);
    conds.push(`c.pipeline = $${params.length}`);
  }
  if (filter.outcome) {
    params.push(filter.outcome);
    conds.push(`(la.assessment->>'outcome') = $${params.length}`);
  }
  if (filter.band) {
    params.push(filter.band);
    conds.push(`(la.assessment->>'band') = $${params.length}`);
  }
  if (filter.service) {
    params.push(`%${filter.service}%`);
    conds.push(`(la.assessment->'dimensions'->'service_fit'->>'explanation') ilike $${params.length}`);
  }
  if (filter.drifted) conds.push("c.drift_detected_at is not null");
  if (filter.hasResearch) {
    conds.push(
      "exists (select 1 from p2.research_task t where t.case_id = c.case_id and t.status in ('open','accepted'))",
    );
  }
  // Suppressed records never appear as pursuit-ready (default); the filter
  // exists so auditors can still list them — with the reason attached.
  const hideSuppressed = filter.hideSuppressed !== false;
  const where = conds.length > 0 ? `where ${conds.join(" and ")}` : "";
  const total = await pool.query(
    `select count(*)::int as n from p2.case c
     left join lateral (
       select a.assessment from p2.case_assessment a
       where a.case_id = c.case_id order by a.version desc limit 1
     ) la on true
     left join lateral (
       select v.suppression_reason from public.v_opportunity_for_qualification_v1 v
       where v.opportunity_id = c.discovery_opportunity_id
     ) vs on true ${where}${hideSuppressed ? (where ? " and " : "where ") + "vs.suppression_reason is null" : ""}`,
    params as never[],
  );
  const sort =
    filter.sort === "updated"
      ? "c.updated_at desc, c.case_id asc"
      : filter.sort === "created"
        ? "c.created_at desc, c.case_id asc"
        : filter.sort === "confidence"
          ? "(la.assessment->'dimensions'->'evidence_confidence'->>'score')::float desc nulls last, c.case_id asc"
          : "(la.assessment->>'composite')::float desc nulls last, c.case_id asc";
  const limit = Math.min(Math.max(filter.limit ?? 25, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);
  const rows = await pool.query(
    `select c.case_id, c.case_ref, c.discovery_opportunity_id, c.discovery_opportunity_key,
            co.name as company_name, c.pipeline, c.status, vs.suppression_reason, c.drift_detected_at,
            la.assessment->>'outcome' as latest_outcome,
            (la.assessment->>'composite')::float as latest_composite,
            la.assessment->>'band' as latest_band,
            (select max(version)::int from p2.case_assessment a where a.case_id = c.case_id) as latest_version,
            (select max(decided_at) from p2.case_assessment a where a.case_id = c.case_id) as latest_decided_at,
            (select d.decision from p2.case_decision d where d.case_id = c.case_id order by d.decided_at desc limit 1) as latest_decision,
            (select count(*)::int from p2.research_task t where t.case_id = c.case_id and t.status in ('open','accepted')) as open_tasks
     from p2.case c
     left join public.opportunity o on o.id = c.discovery_opportunity_id
     left join public.company co on co.id = o.company_id
     left join lateral (
       select a.assessment from p2.case_assessment a
       where a.case_id = c.case_id order by a.version desc limit 1
     ) la on true
     left join lateral (
       select v.suppression_reason from public.v_opportunity_for_qualification_v1 v
       where v.opportunity_id = c.discovery_opportunity_id
     ) vs on true
     ${where}${hideSuppressed ? (where ? " and " : "where ") + "vs.suppression_reason is null" : ""}
     order by ${sort} limit $${params.length + 1} offset $${params.length + 2}`,
    [...(params as never[]), limit, offset] as never[],
  );
  return {
    total: (total.rows[0] as { n: number }).n,
    rows: (rows.rows as Record<string, unknown>[]).map((r) => ({
      case_id: r.case_id as string,
      case_ref: r.case_ref as string,
      discovery_opportunity_id: r.discovery_opportunity_id as string,
      discovery_opportunity_key: r.discovery_opportunity_key as string,
      company_name: (r.company_name as string | null) ?? null,
      pipeline: r.pipeline as string,
      status: r.status as string,
      suppression_reason: (r.suppression_reason as string | null) ?? null,
      drift_detected_at: r.drift_detected_at ? (r.drift_detected_at as Date).toISOString() : null,
      latest_outcome: (r.latest_outcome as string | null) ?? null,
      latest_composite: (r.latest_composite as number | null) ?? null,
      latest_band: (r.latest_band as string | null) ?? null,
      latest_version: (r.latest_version as number | null) ?? null,
      latest_decided_at: r.latest_decided_at ? (r.latest_decided_at as Date).toISOString() : null,
      latest_decision: (r.latest_decision as string | null) ?? null,
      open_tasks: (r.open_tasks as number) ?? 0,
    })),
  };
}

export interface TodayData {
  activePolicy: boolean;
  activeCatalog: boolean;
  activeRubric: boolean;
  unsettledInbox: number;
  driftedCases: number;
  overdueTasks: { task_id: string; case_id: string; question: string; due_at: string }[];
  openTasks: number;
  runningRuns: number;
  topLeads: { case_id: string; company_name: string | null; composite: number; band: string | null }[];
  recentDecisions: { case_id: string; decision: string; actor: string; decided_at: string }[];
}

/** Today screen: priorities, attention items, health warnings. Read-only. */
export async function todayData(pool: Pool = getPool(), nowIso?: string): Promise<TodayData> {
  const now = nowIso ?? new Date().toISOString();
  const active = await pool.query(
    "select kind, count(*)::int as n from p2.reference_version where status = 'active' and kind in ('policy','service_catalog','rubric') group by kind",
  );
  const kinds = new Set((active.rows as { kind: string }[]).map((r) => r.kind));
  const unsettled = await pool.query(
    "select count(*)::int as n from p2.event_inbox where status = 'claimed'",
  );
  const drifted = await pool.query(
    "select count(*)::int as n from p2.case where drift_detected_at is not null",
  );
  const overdue = await pool.query(
    `select task_id, case_id, question, due_at from p2.research_task
     where status in ('open','accepted') and due_at is not null and due_at <= $1::timestamptz
     order by due_at limit 20`,
    [now],
  );
  const openTasks = await pool.query(
    "select count(*)::int as n from p2.research_task where status in ('open','accepted')",
  );
  const running = await pool.query(
    "select count(*)::int as n from public.discovery_run where status = 'running'",
  );
  const top = await pool.query(
    `select c.case_id, co.name as company_name,
            (a.assessment->>'composite')::float as composite,
            a.assessment->>'band' as band
     from p2.case c
     join lateral (
       select a2.assessment from p2.case_assessment a2
       where a2.case_id = c.case_id order by a2.version desc limit 1
     ) a on true
     left join public.opportunity o on o.id = c.discovery_opportunity_id
     left join public.company co on co.id = o.company_id
     where a.assessment->>'outcome' = 'eligible_for_assessment'
       and c.drift_detected_at is null
     order by (a.assessment->>'composite')::float desc nulls last limit 5`,
  );
  const recent = await pool.query(
    `select entity_id as case_id, action, actor, occurred_at from p2.audit_event
     where entity_type = 'case' and action like 'decision_%'
     order by occurred_at desc limit 10`,
  );
  return {
    activePolicy: kinds.has("policy"),
    activeCatalog: kinds.has("service_catalog"),
    activeRubric: kinds.has("rubric"),
    unsettledInbox: (unsettled.rows[0] as { n: number }).n,
    driftedCases: (drifted.rows[0] as { n: number }).n,
    overdueTasks: (overdue.rows as Record<string, unknown>[]).map((r) => ({
      task_id: r.task_id as string,
      case_id: r.case_id as string,
      question: r.question as string,
      due_at: (r.due_at as Date).toISOString(),
    })),
    openTasks: (openTasks.rows[0] as { n: number }).n,
    runningRuns: (running.rows[0] as { n: number }).n,
    topLeads: (top.rows as Record<string, unknown>[]).map((r) => ({
      case_id: r.case_id as string,
      company_name: (r.company_name as string | null) ?? null,
      composite: (r.composite as number) ?? 0,
      band: (r.band as string | null) ?? null,
    })),
    recentDecisions: (recent.rows as Record<string, unknown>[]).map((r) => ({
      case_id: r.entity_id as string,
      decision: (r.action as string).replace(/^decision_/, ""),
      actor: r.actor as string,
      decided_at: (r.occurred_at as Date).toISOString(),
    })),
  };
}

export interface PolicyVersionRow {
  kind: string;
  version: string;
  status: string;
  recorded_by: string;
  recorded_at: string;
}

/** All reference versions with status (policy + catalog + rubric + capacity + schema). */
export async function policyVersions(pool: Pool = getPool()): Promise<PolicyVersionRow[]> {
  const r = await pool.query(
    "select kind, version, status, recorded_by, recorded_at from p2.reference_version order by kind, recorded_at desc",
  );
  return (r.rows as Record<string, unknown>[]).map((x) => ({
    kind: x.kind as string,
    version: x.version as string,
    status: x.status as string,
    recorded_by: x.recorded_by as string,
    recorded_at: (x.recorded_at as Date).toISOString(),
  }));
}

export interface AuditMetrics {
  decisionsByType: { decision: string; n: number }[];
  gateOutcomes: { outcome: string; n: number }[];
  assessmentsTotal: number;
  staleAssessed: number;
  drifted: number;
  tasksByStatus: { status: string; n: number }[];
  overdueTasks: number;
}

/** Audit + metrics: decisions, gate outcomes, staleness, drift, tasks. Read-only. */
export async function auditMetrics(pool: Pool = getPool(), nowIso?: string): Promise<AuditMetrics> {
  const now = nowIso ?? new Date().toISOString();
  const decisions = await pool.query(
    "select decision, count(*)::int as n from p2.case_decision group by decision order by decision",
  );
  const outcomes = await pool.query(
    `select assessment->>'outcome' as outcome, count(*)::int as n
     from (select distinct on (case_id) case_id, assessment from p2.case_assessment order by case_id, version desc) latest
     group by 1 order by 1`,
  );
  const total = await pool.query("select count(*)::int as n from p2.case_assessment");
  const stale = await pool.query(
    `select count(*)::int as n from p2.case c
     join lateral (select assessment_id from p2.case_assessment a where a.case_id = c.case_id order by version desc limit 1) la on true
     where c.discovery_state_hash <> coalesce((select snapshot_hash from p2.case_assessment a2 where a2.assessment_id = la.assessment_id), '')`,
  );
  const drifted = await pool.query("select count(*)::int as n from p2.case where drift_detected_at is not null");
  const tasks = await pool.query("select status, count(*)::int as n from p2.research_task group by status order by status");
  const overdue = await pool.query(
    "select count(*)::int as n from p2.research_task where status in ('open','accepted') and due_at is not null and due_at <= $1::timestamptz",
    [now],
  );
  return {
    decisionsByType: decisions.rows as { decision: string; n: number }[],
    gateOutcomes: (outcomes.rows as { outcome: string | null; n: number }[]).map((r) => ({
      outcome: r.outcome ?? "none",
      n: r.n,
    })),
    assessmentsTotal: (total.rows[0] as { n: number }).n,
    staleAssessed: (stale.rows[0] as { n: number }).n,
    drifted: (drifted.rows[0] as { n: number }).n,
    tasksByStatus: tasks.rows as { status: string; n: number }[],
    overdueTasks: (overdue.rows[0] as { n: number }).n,
  };
}

export interface AdminStatus {
  migrationsApplied: number;
  verificationNote: string;
  consumers: { consumer_name: string; last_outbox_id: number; applied_count: number; dead_count: number }[];
  unsettledByConsumer: { consumer_name: string; n: number }[];
  lastBackup: { file: string; bytes: number; taken: string } | null;
  outboxTotal: number;
  casesTotal: number;
}

/** Administration + recovery status. Read-only; actions run through routes/scripts. */
export async function adminStatus(pool: Pool = getPool()): Promise<AdminStatus> {
  const migrations = await pool.query("select count(*)::int as n from public.schema_migrations");
  const consumers = await pool.query(
    "select consumer_name, last_outbox_id, applied_count, dead_count from p2.consumer_watermark order by consumer_name",
  );
  const unsettled = await pool.query(
    "select consumer_name, count(*)::int as n from p2.event_inbox where status = 'claimed' group by consumer_name",
  );
  const outbox = await pool.query("select count(*)::int as n from public.discovery_outbox");
  const cases = await pool.query("select count(*)::int as n from p2.case");
  return {
    migrationsApplied: (migrations.rows[0] as { n: number }).n,
    verificationNote: "canonical check: node scripts/db.mjs verify (dev) — see runbook §2",
    consumers: (consumers.rows as Record<string, unknown>[]).map((r) => ({
      consumer_name: r.consumer_name as string,
      last_outbox_id: Number(r.last_outbox_id),
      applied_count: Number(r.applied_count),
      dead_count: Number(r.dead_count),
    })),
    unsettledByConsumer: unsettled.rows as { consumer_name: string; n: number }[],
    lastBackup: null, // filled by the page from backup manifests on disk
    outboxTotal: (outbox.rows[0] as { n: number }).n,
    casesTotal: (cases.rows[0] as { n: number }).n,
  };
}
