import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { setCapabilityStatus } from "@/lib/sales/catalog";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/catalog/[key]/status — change approval state with rationale.
 * Body: { status: draft|needs_owner_review|approved, reason, actor? }.
 * The operator may be the owner; the audit trail records who decided what.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  const { key } = await ctx.params;
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
    const result = await setCapabilityStatus(getPool(), decodeURIComponent(key), {
      status: typeof body["status"] === "string" ? body["status"] : "",
      reason: typeof body["reason"] === "string" ? body["reason"] : "",
      actor: (auth.email ?? actorOf(body)),
    });
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
