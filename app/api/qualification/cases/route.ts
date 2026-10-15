import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { requireOperatorApi } from "@/lib/auth/guard";

/**
 * GET /api/qualification/cases — qualification case queue (projection).
 * Query: status= (discovered|assessing|assessed|rejected|archived),
 * drifted=true (only drift-flagged), limit= 1..200 (default 50), offset= ≥0.
 * Totals accompany capped rows: no silent omission. Read-only; never writes.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireOperatorApi(req);
  if (!auth.ok) return auth.response!;
  const url = new URL(req.url);
  const status = (url.searchParams.get("status") ?? "").trim();
  const drifted = (url.searchParams.get("drifted") ?? "").trim() === "true";
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
  const offset = Math.max(Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0, 0);
  const valid = ["discovered", "assessing", "assessed", "rejected", "archived"];
  if (status !== "" && !valid.includes(status)) {
    return NextResponse.json(
      { code: "bad_status", message: `status must be one of: ${valid.join(", ")}` },
      { status: 422 },
    );
  }
  try {
    const params: unknown[] = [];
    const conds: string[] = [];
    if (status !== "") {
      params.push(status);
      conds.push(`c.status = $${params.length}`);
    }
    if (drifted) conds.push("c.drift_detected_at is not null");
    const where = conds.length > 0 ? `where ${conds.join(" and ")}` : "";
    const total = await getPool().query(
      `select count(*)::int as n from p2.case c ${where}`,
      params,
    );
    params.push(limit, offset);
    const rows = await getPool().query(
      `select c.case_id, c.case_ref, c.discovery_opportunity_id, c.discovery_opportunity_key,
              c.pipeline, c.status, c.discovery_updated_at, c.drift_detected_at,
              c.latest_sequence, c.created_at, c.updated_at, c.created_by,
              (select count(*)::int from p2.case_assessment a where a.case_id = c.case_id) as assessments,
              (select count(*)::int from p2.research_task t where t.case_id = c.case_id and t.status in ('open','accepted')) as open_tasks
       from p2.case c ${where}
       order by c.updated_at desc, c.case_id asc
       limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return NextResponse.json(
      { total: total.rows[0].n, limit, offset, items: rows.rows },
      { status: 200 },
    );
  } catch {
    return NextResponse.json({ code: "internal", message: "internal error" }, { status: 500 });
  }
}
