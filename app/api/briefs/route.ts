import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { createBrief } from "@/lib/sales/briefs";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/briefs — explicit brief creation from an accepted proposal.
 * Body: { proposalId, actor?, reviewer? }. One active brief per proposal;
 * inputs frozen by hash; hypotheses/evidence linked by version.
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
  try {
    const result = await createBrief(getPool(), {
      proposalId: typeof body["proposalId"] === "string" ? body["proposalId"] : "",
      actor: (auth.email ?? actorOf(body)),
      reviewer: typeof body["reviewer"] === "string" ? body["reviewer"] : undefined,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
