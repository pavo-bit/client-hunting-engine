import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { requireOperatorApi } from "@/lib/auth/guard";

/** GET /api/hypotheses?company=&status= — bounded review list (read-only). */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireOperatorApi(req);
  if (!auth.ok) return auth.response!;
  const url = new URL(req.url);
  const company = (url.searchParams.get("company") ?? "").slice(0, 100);
  const status = (url.searchParams.get("status") ?? "").slice(0, 30);
  try {
    const params: unknown[] = [];
    const conds: string[] = [];
    if (company !== "") {
      params.push(`%${company}%`);
      conds.push(`c.name ilike $${params.length}`);
    }
    if (status !== "") {
      params.push(status);
      conds.push(`h.status = $${params.length}`);
    }
    params.push(500);
    const r = await getPool().query(
      `select h.id, h.company_id, c.name as company_name, h.title,
              h.opportunity_category, h.status, h.rule_id, h.rule_version,
              h.created_at
       from public.hypothesis h join public.company c on c.id = h.company_id
       ${conds.length > 0 ? `where ${conds.join(" and ")}` : ""}
       order by h.created_at desc limit $${params.length}`,
      params,
    );
    return NextResponse.json({ hypotheses: r.rows }, { status: 200 });
  } catch {
    return NextResponse.json(
      { code: "internal", message: "internal error" },
      { status: 500 },
    );
  }
}
