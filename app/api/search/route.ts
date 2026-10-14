import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi } from "@/lib/auth/guard";
import { globalSearch } from "@/lib/search/global";

/**
 * GET /api/search?q=&perDomain= — global trigram search across companies,
 * claims, hypotheses, proposals, and briefs (read-only projection).
 * Authenticated; bounded (2..200 chars, 1..25 per domain).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireOperatorApi(req);
  if (!auth.ok) return auth.response!;
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const per = Number.parseInt(url.searchParams.get("perDomain") ?? "10", 10);
  try {
    const result = await globalSearch(getPool(), q, Number.isFinite(per) ? per : 10);
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
