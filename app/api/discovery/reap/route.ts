import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";
import { reapStaleRuns } from "@/lib/discovery/reap";

/**
 * POST /api/discovery/reap — close out crashed/stalled runs (B-D6).
 * Body: { staleAfterMinutes: number (required, no default), dryRun?: boolean }.
 * Operator-triggered only: no scheduler, no background job, no resume. Every
 * reaped run becomes `failed` with a reason + audit row; nothing is deleted.
 * Use dryRun first: no heartbeat exists, so the threshold is the operator's
 * call (docs/RUNBOOK.md §5b).
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
    const result = await reapStaleRuns(getPool(), {
      staleAfterMinutes: body["staleAfterMinutes"],
      actor: auth.email ?? actorOf(body),
      dryRun: body["dryRun"] === true,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}