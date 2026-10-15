import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi } from "@/lib/auth/guard";

/**
 * GET /api/opportunities — accumulated opportunity collection (projection).
 * Query: pipeline= (default agency_partner; direct_client rows cannot exist
 * yet — O1), status=, q= (bounded substring over key/title/company, ≤200),
 * limit= 1..200 (default 50), offset= ≥0. Totals always accompany capped
 * rows: no silent omission. Read-only; never writes.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireOperatorApi(req);
  if (!auth.ok) return auth.response!;
  const url = new URL(req.url);
  const pipeline = (url.searchParams.get("pipeline") ?? "agency_partner").trim();
  if (pipeline !== "agency_partner" && pipeline !== "direct_client") {
    return NextResponse.json(
      { code: "bad_pipeline", message: "pipeline must be agency_partner or direct_client" },
      { status: 422 },
    );
  }
  const status = (url.searchParams.get("status") ?? "").trim().slice(0, 30);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
  const offset = Math.max(Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0, 0);
  try {
    const params: unknown[] = [pipeline];
    const conds = ["o.pipeline = $1"];
    if (status !== "") {
      params.push(status);
      conds.push(`o.status = $${params.length}`);
    }
    if (q !== "") {
      params.push(`%${q}%`);
      conds.push(
        `(o.opportunity_key ilike $${params.length} or coalesce(c.name, '') ilike $${params.length})`,
      );
    }
    const where = `where ${conds.join(" and ")}`;
    const total = await getPool().query(
      `select count(*)::int as n from public.opportunity o
       left join public.company c on c.id = o.company_id ${where}`,
      params,
    );
    params.push(limit, offset);
    const rows = await getPool().query(
      `select o.id, o.pipeline, o.opportunity_key, o.status, o.solution_status,
              o.first_seen_at, o.created_at,
              c.id as company_id, c.name as company_name
       from public.opportunity o
       left join public.company c on c.id = o.company_id
       ${where} order by o.created_at desc, o.id asc
       limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return NextResponse.json(
      { total: total.rows[0].n, limit, offset, items: rows.rows },
      { status: 200 },
    );
  } catch {
    return NextResponse.json(
      { code: "internal", message: "internal error" },
      { status: 500 },
    );
  }
}
