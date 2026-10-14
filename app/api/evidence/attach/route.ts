import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { attachEvidence } from "@/lib/evidence/ingest";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/evidence/attach — link supporting/contradicting/contextual
 * evidence to a claim. Body: { claimId, snapshotId?, linkedClaimId?,
 * polarity, note?, actor? }. Exactly one target. Contradictions preserved,
 * never deleted to make a claim look consistent.
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
    const result = await attachEvidence(getPool(), {
      claimId: typeof body["claimId"] === "string" ? body["claimId"] : "",
      snapshotId: typeof body["snapshotId"] === "string" ? body["snapshotId"] : undefined,
      linkedClaimId:
        typeof body["linkedClaimId"] === "string" ? body["linkedClaimId"] : undefined,
      polarity: body["polarity"] as "supports" | "contradicts" | "contextual",
      note: typeof body["note"] === "string" ? body["note"] : "",
      actor: (auth.email ?? actorOf(body)),
    });
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
