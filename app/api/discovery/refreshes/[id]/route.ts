import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi } from "@/lib/auth/guard";
import { refreshSummary } from "@/lib/discovery/refresh";

/**
 * GET /api/discovery/refreshes/[id] — refresh status + coverage + measures.
 * Query: ?target_agency=&target_direct= (caller-stated shortfall targets;
 * absent targets mean no shortfall rows — no approved allocation exists).
 * Read-only projection; never writes.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireOperatorApi(req);
  if (!auth.ok) return auth.response!;
  const { id } = await ctx.params;
  // Path ids are operator input too: an invalid uuid must be a clean refusal,
  // never a raw database error surfaced as 500.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json(
      { code: "bad_id", message: "run id must be a uuid" },
      { status: 422 },
    );
  }
  const url = new URL(req.url);
  const parseTarget = (v: string | null): number | undefined => {
    if (v === null || v === "") return undefined;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const ta = parseTarget(url.searchParams.get("target_agency"));
  const td = parseTarget(url.searchParams.get("target_direct"));
  try {
    const summary = await refreshSummary(
      getPool(),
      id,
      ta === undefined && td === undefined ? undefined : { agency_partner: ta ?? 0, direct_client: td ?? 0 },
    );
    return NextResponse.json(summary, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
