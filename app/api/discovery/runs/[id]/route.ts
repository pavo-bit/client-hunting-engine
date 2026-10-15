import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { requireOperatorApi } from "@/lib/auth/guard";
import { listIdentityConflicts } from "@/lib/resolve/conflicts";

/** GET /api/discovery/runs/[id] — run detail + per-record items (read-only). */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireOperatorApi(_req);
  if (!auth.ok) return auth.response!;
  const { id } = await ctx.params;
  // Invalid uuid => clean 422, never a raw database error as 500.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json(
      { code: "bad_id", message: "run id must be a uuid" },
      { status: 422 },
    );
  }
  try {
    const pool = getPool();
    const run = await pool.query(
      `select id, adapter_id, adapter_version, status, query_text, started_at,
              finished_at, found, created_new, duplicates, skipped, conflicts,
              failed_items, error, created_by
       from public.discovery_run where id = $1`,
      [id],
    );
    if (run.rows.length === 0)
      return NextResponse.json(
        { code: "not_found", message: "discovery run not found" },
        { status: 404 },
      );
    const items = await pool.query(
      `select source_record_id, status, company_id, candidate_id, warnings, note
       from public.discovery_run_item where run_id = $1 order by created_at limit 500`,
      [id],
    );
    // Identity conflicts captured for this run (M7). Read-only projection:
    // they are review artifacts, not merges.
    const conflicts = await listIdentityConflicts(pool, { runId: id, limit: 200 });
    return NextResponse.json(
      { run: run.rows[0], items: items.rows, identity_conflicts: conflicts },
      { status: 200 },
    );
  } catch {
    return NextResponse.json(
      { code: "internal", message: "internal error" },
      { status: 500 },
    );
  }
}
