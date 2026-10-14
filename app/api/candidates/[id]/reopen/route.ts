import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { reopenCandidate } from "@/lib/resolve/engine";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/candidates/[id]/reopen — return a decided candidate to pending
 * with new material evidence. Body: { reason, actor? }. Prior decision is
 * preserved in the audit trail; accepted (merged) candidates stay decided.
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
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { code: "bad_json", message: "request body must be JSON" },
      { status: 400 },
    );
  }
  try {
    const result = await reopenCandidate(getPool(), id, {
      reason: typeof body["reason"] === "string" ? body["reason"] : "",
      actor: (auth.email ?? actorOf(body)),
    });
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
