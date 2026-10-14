import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { decideHypothesis } from "@/lib/hypothesis/rules";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/hypotheses/[id]/decision — human review decision.
 * Body: { decision: validate|defer|reject|request_evidence|supersede,
 * reason, actor? }. Reason required; superseded rows stay decided; audit
 * stamped. Validation records a reviewer's judgment — it never proves the
 * company's internal problem as objective fact.
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
    const result = await decideHypothesis(getPool(), id, {
      decision: typeof body["decision"] === "string" ? body["decision"] : "",
      reason: typeof body["reason"] === "string" ? body["reason"] : "",
      actor: (auth.email ?? actorOf(body)),
    });
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
