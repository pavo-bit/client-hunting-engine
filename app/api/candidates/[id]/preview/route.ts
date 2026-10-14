import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { previewCandidate } from "@/lib/resolve/engine";
import { intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi } from "@/lib/auth/guard";

/** GET /api/candidates/[id]/preview — explicit merge-impact preview (read-only). */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireOperatorApi(_req);
  if (!auth.ok) return auth.response!;
  const { id } = await ctx.params;
  try {
    const preview = await previewCandidate(getPool(), id);
    return NextResponse.json(preview, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
