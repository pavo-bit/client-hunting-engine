import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi } from "@/lib/auth/guard";
import { eligibilityHistory } from "@/lib/discovery/eligibility";

/**
 * GET /api/opportunities/[key] — one opportunity with evidence, eligibility
 * history, and lifecycle (all projections; never writes). Key is
 * URI-encoded (slashes possible in theory — decode first).
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  const auth = await requireOperatorApi(req);
  if (!auth.ok) return auth.response!;
  const { key } = await ctx.params;
  const pipeline = (new URL(req.url).searchParams.get("pipeline") ?? "agency_partner").trim();
  if (pipeline !== "agency_partner" && pipeline !== "direct_client") {
    return NextResponse.json(
      { code: "bad_pipeline", message: "pipeline must be agency_partner or direct_client" },
      { status: 422 },
    );
  }
  try {
    const pool = getPool();
    const o = await pool.query(
      `select o.id, o.pipeline, o.opportunity_key, o.status, o.solution_status,
              o.first_seen_at, o.created_at, o.updated_at,
              c.id as company_id, c.name as company_name,
              c.domain_norm, c.registry_id, c.merged_into
       from public.opportunity o
       left join public.company c on c.id = o.company_id
       where o.pipeline = $1 and o.opportunity_key = $2`,
      [pipeline, decodeURIComponent(key)],
    );
    if (o.rows.length === 0) {
      return NextResponse.json(
        { code: "opportunity_not_found", message: "opportunity not found" },
        { status: 404 },
      );
    }
    const row = o.rows[0];
    const evidence =
      row.company_id == null
        ? []
        : (
            await pool.query(
              `select cl.id, left(cl.claim_text, 200) as text, cl.claim_status,
                      s.url, s.source_key, cl.created_at
               from public.claim cl
               join public.snapshot s on s.id = cl.snapshot_id
               where cl.company_id = $1 order by cl.created_at desc limit 100`,
              [row.company_id],
            )
          ).rows;
    const history = await eligibilityHistory(pool, row.id as string);
    const lifecycle = (
      await pool.query(
        `select transition_from, transition_to, actor, reason, created_at
         from public.audit_log where entity_type = 'opportunity' and entity_id = $1
         order by created_at`,
        [row.id],
      )
    ).rows;
    return NextResponse.json(
      { opportunity: row, evidence, eligibility_history: history, lifecycle },
      { status: 200 },
    );
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
