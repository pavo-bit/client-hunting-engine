import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { generateHypotheses } from "@/lib/hypothesis/rules";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/hypotheses/generate — evaluate deterministic rules for a company.
 * Body: { companyId, actor? }. Idempotent per (company, rule); re-evaluation
 * tops up evidence, supersedes materially changed decided rows (audited).
 * Returns explicit noSupportedHypothesis when no rule fires.
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
  const companyId = typeof body["companyId"] === "string" ? body["companyId"] : "";
  if (companyId === "")
    return NextResponse.json(
      { code: "missing_company", message: "companyId is required" },
      { status: 422 },
    );
  try {
    const result = await generateHypotheses(getPool(), companyId, (auth.email ?? actorOf(body)));
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
