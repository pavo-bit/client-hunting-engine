import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { getProductionRegistry } from "@/lib/discovery/production";
import { runDiscovery } from "@/lib/discovery/run";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/discovery/runs — start a bounded discovery run (synchronous).
 * Body: { adapterId?, text, limit?, maxPages?, actor? }.
 * Bounds: text 1..200 chars, limit 1..25, maxPages 1..3, 120s run timeout.
 * No scheduler, no resume: a crashed run stays `running` (documented) and
 * rerunning is idempotent. Companies are created or queued, never updated.
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
    const result = await runDiscovery(getPool(), getProductionRegistry(), {
      adapterId: typeof body["adapterId"] === "string" ? body["adapterId"] : "gleif-lei",
      queryText: typeof body["text"] === "string" ? body["text"] : "",
      limit: typeof body["limit"] === "number" ? body["limit"] : 10,
      maxPages: typeof body["maxPages"] === "number" ? body["maxPages"] : 3,
      actor: (auth.email ?? actorOf(body)),
      signal: req.signal,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}

/** GET /api/discovery/runs — bounded run history (read-only). */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireOperatorApi(req);
  if (!auth.ok) return auth.response!;
  try {
    const r = await getPool().query(
      `select id, adapter_id, adapter_version, status, query_text, started_at,
              finished_at, found, created_new, duplicates, skipped, conflicts,
              failed_items, error, created_by
       from public.discovery_run order by started_at desc limit 200`,
    );
    return NextResponse.json({ runs: r.rows }, { status: 200 });
  } catch {
    return NextResponse.json(
      { code: "internal", message: "internal error" },
      { status: 500 },
    );
  }
}
