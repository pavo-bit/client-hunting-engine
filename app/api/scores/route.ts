import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { rankedOpportunities } from "@/lib/scoring/evaluate";
import { requireOperatorApi } from "@/lib/auth/guard";

/** GET /api/scores — ranked eligible opportunities with freshness (read-only). */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const auth = await requireOperatorApi(_req);
  if (!auth.ok) return auth.response!;
  try {
    const rows = await rankedOpportunities(getPool());
    return NextResponse.json({ ranking: rows, model: "score_v1" }, { status: 200 });
  } catch {
    return NextResponse.json(
      { code: "internal", message: "internal error" },
      { status: 500 },
    );
  }
}
