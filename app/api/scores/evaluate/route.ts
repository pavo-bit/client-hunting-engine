import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { evaluateHypothesis } from "@/lib/scoring/evaluate";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/scores/evaluate — gate, compute, and persist one score_v1 run.
 * Body: { hypothesisId, actor? }. Ineligible hypotheses get NO row (409 with
 * gate reasons). History accumulates; recalculation never deletes.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
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
  const hypothesisId = typeof body["hypothesisId"] === "string" ? body["hypothesisId"] : "";
  if (hypothesisId === "")
    return NextResponse.json(
      { code: "missing_hypothesis", message: "hypothesisId is required" },
      { status: 422 },
    );
  try {
    const result = await evaluateHypothesis(getPool(), hypothesisId, (auth.email ?? actorOf(body)));
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
