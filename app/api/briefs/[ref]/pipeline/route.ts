import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { recordPipelineEvent } from "@/lib/sales/briefs";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/briefs/[ref]/pipeline — record a pipeline stage change.
 * Body: { stage, note (required), nextAction?, followUpDate? (YYYY-MM-DD),
 * occurredAt?, actor? }. History appended; brief updated; audited. Stages
 * describe operator-observed reality — "ready_for_outreach" never means sent.
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
    const result = await recordPipelineEvent(getPool(), decodeURIComponent(ref), {
      stage: typeof body["stage"] === "string" ? body["stage"] : "",
      note: typeof body["note"] === "string" ? body["note"] : "",
      nextAction: typeof body["nextAction"] === "string" ? body["nextAction"] : undefined,
      followUpDate: typeof body["followUpDate"] === "string" ? body["followUpDate"] : undefined,
      occurredAt: typeof body["occurredAt"] === "string" ? body["occurredAt"] : undefined,
      actor: (auth.email ?? actorOf(body)),
    });
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
