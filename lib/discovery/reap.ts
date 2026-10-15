// Crashed/stalled run recovery (blocker B-D6).
//
// A run that dies mid-flight (process killed, crash, aborted request) leaves a
// `running` row and `running`/`pending` coverage tasks forever: history lies
// ("still running") and end-state summaries can never reach a terminal value.
// There is NO scheduler here - reaping is an explicit operator action with an
// operator-stated threshold, dry-run first (no heartbeat exists, so the
// threshold is the operator's judgement call; that limitation is documented in
// docs/RUNBOOK.md §5b).
//
// Reaping is conservative and auditable: rows move to terminal states with a
// reason, never deleted; every transition writes an audit_log row.

import type { Pool } from "pg";

const MIN_MINUTES = 1;
const MAX_MINUTES = 10_080; // 7 days: anything older is history, not a crash

export interface StaleRun {
  id: string;
  adapterId: string;
  queryText: string;
  startedAt: string;
  ageMinutes: number;
}

export interface ReapResult {
  dryRun: boolean;
  staleAfterMinutes: number;
  considered: StaleRun[];
  reaped: { runId: string; tasksFailed: number }[];
}

/** Pure threshold validation - no defaults invented (operator states one). */
export function parseStaleAfterMinutes(raw: unknown): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
  if (!Number.isInteger(n) || n < MIN_MINUTES || n > MAX_MINUTES) {
    const e = new Error(
      `staleAfterMinutes must be an integer between ${MIN_MINUTES} and ${MAX_MINUTES}`,
    ) as Error & { status: number; code: string };
    e.status = 422;
    e.code = "bad_stale_threshold";
    throw e;
  }
  return n;
}

function requireActor(actor: string): string {
  const a = (actor ?? "").trim();
  if (a.length < 1 || a.length > 200) {
    const e = new Error("acting operator identity is required for attribution") as Error & {
      status: number;
      code: string;
    };
    e.status = 422;
    e.code = "actor_required";
    throw e;
  }
  return a;
}

/** Candidate runs: still `running`, started longer ago than the threshold. */
export async function findStaleRuns(pool: Pool, staleAfterMinutes: number): Promise<StaleRun[]> {
  const r = await pool.query(
    `select id, adapter_id, query_text, started_at,
            floor(extract(epoch from (now() - started_at)) / 60)::int as age_minutes
     from public.discovery_run
     where status = 'running' and started_at <= now() - make_interval(mins => $1)
     order by started_at asc, id asc`,
    [staleAfterMinutes],
  );
  return (r.rows as { id: string; adapter_id: string; query_text: string; started_at: Date; age_minutes: number }[]).map(
    (x) => ({
      id: x.id,
      adapterId: x.adapter_id,
      queryText: x.query_text,
      startedAt: new Date(x.started_at).toISOString(),
      ageMinutes: x.age_minutes,
    }),
  );
}

/**
 * Mark stale runs (and their unfinished tasks) terminal, with reasons.
 * `dryRun` reports candidates without writing. Locking uses SKIP LOCKED so a
 * concurrent operator action cannot double-reap the same run.
 */
export async function reapStaleRuns(
  pool: Pool,
  input: { staleAfterMinutes: unknown; actor: string; dryRun?: boolean },
): Promise<ReapResult> {
  const minutes = parseStaleAfterMinutes(input.staleAfterMinutes);
  const actor = requireActor(input.actor);
  const dryRun = input.dryRun === true;
  const considered = await findStaleRuns(pool, minutes);
  if (dryRun || considered.length === 0) {
    return { dryRun, staleAfterMinutes: minutes, considered, reaped: [] };
  }
  const client = await pool.connect();
  const reaped: { runId: string; tasksFailed: number }[] = [];
  try {
    await client.query("begin");
    for (const run of considered) {
      const locked = await client.query(
        `select id from public.discovery_run
         where id = $1 and status = 'running'
         for update skip locked`,
        [run.id],
      );
      if (locked.rows.length === 0) continue; // finished or reaped concurrently
      const reason = `reaped: still running ${run.ageMinutes} min after start (threshold ${minutes} min) - process ended without finalizing`;
      const tasks = await client.query(
        `update public.discovery_coverage_task
         set status = 'failed', finished_at = now(),
             note = left(coalesce(note, '') || $2, 2000)
         where run_id = $1 and status in ('pending', 'running')
         returning id`,
        [run.id, reason],
      );
      await client.query(
        // Belt and braces with the row lock taken above: even if the lock were
        // ever dropped, a run that reached a terminal state in the meantime is
        // never re-opened or overwritten by the reaper.
        `update public.discovery_run
         set status = 'failed', finished_at = now(), error = left($2, 2000)
         where id = $1 and status = 'running'`,
        [run.id, reason],
      );
      await client.query(
        `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
         values ('discovery_run', $1, $2, 'running', 'failed', $3)`,
        [run.id, actor, reason],
      );
      await client.query(
        `insert into public.failure_log (entity_type, entity_id, cause_class, detail)
         values ('discovery_run', $1, 'other', $2)`,
        [run.id, reason],
      );
      reaped.push({ runId: run.id, tasksFailed: tasks.rows.length });
    }
    await client.query("commit");
    return { dryRun, staleAfterMinutes: minutes, considered, reaped };
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {
      /* connection already broken */
    }
    throw e;
  } finally {
    client.release();
  }
}