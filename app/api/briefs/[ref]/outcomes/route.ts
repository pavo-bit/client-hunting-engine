import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { recordOutcome } from "@/lib/sales/briefs";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/briefs/[ref]/outcomes — record a manually observed outcome.
 * Body: { channel?, outcome, rejectionCode?, note?, sentAtManual?, actor? }.
 * Human-observed events only; nothing here infers, sends, or syncs.
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
    const result = await recordOutcome(getPool(), decodeURIComponent(ref), {
      channel: typeof body["channel"] === "string" ? body["channel"] : undefined,
      outcome: typeof body["outcome"] === "string" ? body["outcome"] : "",
      rejectionCode: typeof body["rejectionCode"] === "string" ? body["rejectionCode"] : undefined,
      note: typeof body["note"] === "string" ? body["note"] : undefined,
      sentAtManual: typeof body["sentAtManual"] === "string" ? body["sentAtManual"] : undefined,
      actor: (auth.email ?? actorOf(body)),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
