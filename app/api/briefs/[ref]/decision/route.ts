import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { decideBrief } from "@/lib/sales/briefs";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/briefs/[ref]/decision — review decision with rationale.
 * Body: { decision: submit|approve|request_info|reject|archive, reason, actor? }.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ ref: string }> },
): Promise<NextResponse> {
  const { ref } = await ctx.params;
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
    const result = await decideBrief(getPool(), decodeURIComponent(ref), {
      decision: typeof body["decision"] === "string" ? body["decision"] : "",
      reason: typeof body["reason"] === "string" ? body["reason"] : "",
      actor: (auth.email ?? actorOf(body)),
    });
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
