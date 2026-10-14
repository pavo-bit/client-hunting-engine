import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { getCompanyDetail } from "@/lib/resolve/detail";
import { requireOperatorApi } from "@/lib/auth/guard";

/** GET /api/companies/[id] — agency detail aggregate (read-only). */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireOperatorApi(_req);
  if (!auth.ok) return auth.response!;
  const { id } = await ctx.params;
  try {
    const detail = await getCompanyDetail(getPool(), id);
    if (!detail)
      return NextResponse.json(
        { code: "not_found", message: "company not found" },
        { status: 404 },
      );
    return NextResponse.json(detail, { status: 200 });
  } catch {
    return NextResponse.json(
      { code: "internal", message: "internal error" },
      { status: 500 },
    );
  }
}
