import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { decideProposal } from "@/lib/proposal/proposals";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/proposals/[id]/decision — review decision.
 * Body: { decision: submit|request_info|accept|reject|archive, reason, actor? }.
 * Rationale required. "Accepted" means Grayscales pursues internally — never
 * client acceptance. Terminal states stay decided.
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
    const result = await decideProposal(getPool(), id, {
      decision: typeof body["decision"] === "string" ? body["decision"] : "",
      reason: typeof body["reason"] === "string" ? body["reason"] : "",
      actor: (auth.email ?? actorOf(body)),
    });
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
