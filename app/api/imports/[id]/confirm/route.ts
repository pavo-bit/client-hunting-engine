import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { confirmImport } from "@/lib/intake/import";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/imports/[id]/confirm — explicit operator confirmation.
 * Revalidates server-side, commits valid rows (partial-success policy),
 * returns imported/skipped/rejected counts with row-level reasons.
 * Idempotent: re-confirming returns the stored summary without rewriting.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const auth = await requireOperatorApi(req);
  if (!auth.ok) return auth.response!;
  const csrf = requireSameOrigin(req, auth);
  if (csrf) return csrf;
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* actor defaults to operator */
  }
  try {
    const result = await confirmImport(getPool(), id, (auth.email ?? actorOf(body)));
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
