import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";
import { getProductionRegistry } from "@/lib/discovery/production";
import { refreshSummary, runRefresh } from "@/lib/discovery/refresh";

/**
 * POST /api/discovery/refreshes — start an explicit manual refresh.
 * Body: { tasks: [{adapterId, queryText, limit?, maxPages?}] (1..25),
 *         stop?: {lowYieldStreak, concentrationCap} (both required together,
 *         positive integers — no defaults exist), actor? }.
 * Executes synchronously in request scope (existing single-operator pattern);
 * child single-query runs stay in history. No scheduling, no autonomy.
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
    const tasks = (body["tasks"] ?? []) as { adapterId?: unknown; queryText?: unknown; limit?: unknown; maxPages?: unknown }[];
    const stopRaw = body["stop"] as { lowYieldStreak?: unknown; concentrationCap?: unknown } | undefined;
    const result = await runRefresh(getPool(), getProductionRegistry(), {
      tasks: tasks.map((t) => ({
        adapterId: typeof t.adapterId === "string" ? t.adapterId : "",
        queryText: typeof t.queryText === "string" ? t.queryText : "",
        limit: typeof t.limit === "number" ? t.limit : undefined,
        maxPages: typeof t.maxPages === "number" ? t.maxPages : undefined,
      })),
      stop:
        stopRaw === undefined
          ? undefined
          : {
              lowYieldStreak: typeof stopRaw.lowYieldStreak === "number" ? stopRaw.lowYieldStreak : 0,
              concentrationCap: typeof stopRaw.concentrationCap === "number" ? stopRaw.concentrationCap : 0,
            },
      actor: auth.email ?? actorOf(body),
    });
    const summary = await refreshSummary(getPool(), result.runId);
    return NextResponse.json({ ...result, endState: summary.endState, measures: summary.measures }, { status: 201 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
