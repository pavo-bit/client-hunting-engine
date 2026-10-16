// Source permission gate (spec amendment §4F, blocker B-D5).
//
// The DB `source.enabled` flag is the SOLE gate for run execution: an adapter
// may run only when its declared source key exists in the source registry and
// is enabled. Fail closed - an unknown key is NOT permission. This closes the
// D0 gap P2 ("neither DB flag nor documented code registry"); the code registry
// decides *which adapters exist*, the DB decides *whether they may run*.
//
// Pure decision first (`decideSource`) so the policy is unit-testable with no
// database; the query wrappers are thin.

import type { Pool, PoolClient } from "pg";

export interface SourceRow {
  key: string;
  enabled: boolean;
  category?: string;
}

export type SourceDecision =
  | { ok: true }
  | { ok: false; code: "source_disabled" | "unknown_source"; message: string };

/** Maximum source key length (matches the source.key CHECK). */
const KEY_MAX = 120;

export function decideSource(row: SourceRow | undefined, sourceKey: string): SourceDecision {
  const key = (sourceKey ?? "").trim();
  if (key.length < 1 || key.length > KEY_MAX) {
    return {
      ok: false,
      code: "unknown_source",
      message: "adapter declared no usable source key; runs cannot be authorized",
    };
  }
  if (!row) {
    return {
      ok: false,
      code: "unknown_source",
      message: `source "${key}" is not in the source registry - permission is not assumed`,
    };
  }
  // Identity check: a row for a DIFFERENT key is not permission for this one
  // (defense in depth - the lookup is already keyed, but the policy must not
  // depend on the caller's SQL).
  if (row.key.trim() !== key) {
    return {
      ok: false,
      code: "unknown_source",
      message: `source "${key}" has no matching registry row (got "${row.key}")`,
    };
  }
  if (!row.enabled) {
    return {
      ok: false,
      code: "source_disabled",
      message: `source "${key}" is disabled in the source registry - re-enable it before running this adapter`,
    };
  }
  return { ok: true };
}

function refusal(d: { code: string; message: string }): Error & { status: number; code: string } {
  // 422 = the adapter names a source we cannot even look up (config error);
  // 409 = known source, operator has not granted permission (state conflict).
  const e = new Error(d.message) as Error & { status: number; code: string };
  e.status = d.code === "unknown_source" ? 422 : 409;
  e.code = d.code;
  return e;
}

/**
 * Throw unless `sourceKey` names an enabled registry source. Called by every
 * run path (single-query runs and planned refresh tasks) BEFORE any write, so
 * a refused run leaves no partial history.
 */
export async function assertSourceEnabled(pool: Pool | PoolClient, sourceKey: string): Promise<void> {
  const r = await pool.query("select key, enabled, category from public.source where key = $1", [
    sourceKey,
  ]);
  const d = decideSource(r.rows[0] as SourceRow | undefined, sourceKey);
  if (!d.ok) throw refusal(d);
}

/** Read-only permission view for the UI (never a decision input elsewhere). */
export async function sourcePermissions(pool: Pool): Promise<
  { key: string; category: string; enabled: boolean }[]
> {
  const r = await pool.query(
    "select key, category, enabled from public.source order by category asc, key asc",
  );
  return r.rows as { key: string; category: string; enabled: boolean }[];
}

/** Source keys an adapter may actually run against right now. */
export function runnableSources(rows: SourceRow[]): string[] {
  return rows.filter((row) => decideSource(row, row.key).ok).map((row) => row.key);
}