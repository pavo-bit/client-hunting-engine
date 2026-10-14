import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { findCandidates } from "@/lib/resolve/engine";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/resolve — run deterministic resolution for one company.
 * Body: { companyId, actor?, autoMerge? }. Auto-merge applies ONLY to
 * domain-exact, conflict-free pairs (older record wins); everything else
 * becomes a review candidate. Idempotent.
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
    const result = await findCandidates(getPool(), companyId, {
      actor: (auth.email ?? actorOf(body)),
      autoMerge: body["autoMerge"] === false ? false : true,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
