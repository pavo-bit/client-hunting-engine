import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { requireOperatorApi } from "@/lib/auth/guard";

/** GET /api/discovery/runs/[id] — run detail + per-record items (read-only). */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireOperatorApi(_req);
  if (!auth.ok) return auth.response!;
  const { id } = await ctx.params;
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
    return NextResponse.json({ run: run.rows[0], items: items.rows }, { status: 200 });
  } catch {
    return NextResponse.json(
      { code: "internal", message: "internal error" },
      { status: 500 },
    );
  }
}
