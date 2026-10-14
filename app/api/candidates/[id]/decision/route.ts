import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { decideCandidate } from "@/lib/resolve/engine";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/candidates/[id]/decision — human accept / reject / defer.
 * Body: { decision, reason?, actor?, allowConflict? }.
 * Accepted runs the merge transaction (older record wins); conflicting
 * registries require explicit allowConflict. Reason required to reject/defer.
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
    const result = await decideCandidate(getPool(), id, {
      decision: body["decision"] as "accepted" | "rejected" | "deferred",
      reason: typeof body["reason"] === "string" ? body["reason"] : "",
      actor: (auth.email ?? actorOf(body)),
      allowConflict: body["allowConflict"] === true,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
