import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { reviseDraft } from "@/lib/sales/drafts";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/drafts/[id]/revise — new version row (history immutable).
 * Body: { subject?, body?, personalization?, unverifiedPoints?, actor? }.
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
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  // Clearing unverified points: send "" (empty string clears to null).
  try {
    const result = await reviseDraft(getPool(), id, (auth.email ?? actorOf(body)), {
      subject: str(body["subject"]),
      body: str(body["body"]),
      personalization: str(body["personalization"]),
      unverifiedPoints: str(body["unverifiedPoints"]),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
