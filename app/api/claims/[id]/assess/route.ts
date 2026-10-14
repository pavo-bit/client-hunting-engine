import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { assessClaim } from "@/lib/evidence/assessment";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/claims/[id]/assess — record an assessment decision.
 * Body: { to, rationale, actor?, automatic? }. verified is human-only;
 * automatic transitions may only promote to corroborated; withdrawn and
 * superseded are terminal. Rationale required; full audit trail written.
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
    const result = await assessClaim(getPool(), id, {
      to: typeof body["to"] === "string" ? body["to"] : "",
      rationale: typeof body["rationale"] === "string" ? body["rationale"] : "",
      actor: (auth.email ?? actorOf(body)),
      automatic: body["automatic"] === true,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
