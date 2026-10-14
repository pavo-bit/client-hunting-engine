import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { createDraft } from "@/lib/sales/drafts";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/drafts — create an outreach draft version.
 * Body: { briefRef, channel, subject?, body, personalization?,
 * unverifiedPoints?, actor? }. Text only — the system cannot send it.
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
    const result = await createDraft(getPool(), {
      briefRef: typeof body["briefRef"] === "string" ? body["briefRef"] : "",
      channel: typeof body["channel"] === "string" ? body["channel"] : "",
      subject: typeof body["subject"] === "string" ? body["subject"] : undefined,
      body: typeof body["body"] === "string" ? body["body"] : "",
      personalization: typeof body["personalization"] === "string" ? body["personalization"] : undefined,
      unverifiedPoints: typeof body["unverifiedPoints"] === "string" ? body["unverifiedPoints"] : undefined,
      actor: (auth.email ?? actorOf(body)),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
