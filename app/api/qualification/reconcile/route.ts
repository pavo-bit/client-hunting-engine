import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";
import { backfillCases, reconcileAll } from "@/lib/qualification/reconcile";
import { readQualificationRow, stateHashOf } from "@/lib/qualification/view";

/**
 * POST /api/qualification/reconcile — operator-triggered reconciliation.
 * Body: { consumer?, idempotencyKey? }. Runs consume → backfill → reconcile
 * for the whole store (no scheduler exists; this route IS the trigger).
 * Without an idempotency key the steps still run — each is idempotent, just
 * not free to repeat.
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
    const consumer =
      typeof body["consumer"] === "string" && body["consumer"].trim() !== ""
        ? body["consumer"].trim().slice(0, 80)
        : "operator";
    const idempotencyKey =
      typeof body["idempotencyKey"] === "string" && body["idempotencyKey"].trim() !== ""
        ? body["idempotencyKey"].trim().slice(0, 200)
        : undefined;
    const report = await reconcileAll(getPool(), {
      consumer,
      actor: auth.email ?? actorOf(body),
      idempotencyKey,
    });
    return NextResponse.json(report, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}

/** GET /api/qualification/reconcile — drift preview. Pure read; writes nothing. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireOperatorApi(req);
  if (!auth.ok) return auth.response!;
  try {
    const pool = getPool();
    const all = await pool.query(
      "select case_id, discovery_opportunity_id, discovery_state_hash, drift_detected_at from p2.case",
    );
    const wouldDrift: string[] = [];
    const orphaned: string[] = [];
    for (
      const c of all.rows as {
        case_id: string;
        discovery_opportunity_id: string;
        discovery_state_hash: string;
      }[]
    ) {
      const row = await readQualificationRow(pool, c.discovery_opportunity_id);
      if (!row) {
        orphaned.push(c.case_id);
        continue;
      }
      if (stateHashOf(row) !== c.discovery_state_hash) wouldDrift.push(c.case_id);
    }
    return NextResponse.json(
      {
        casesChecked: all.rows.length,
        wouldDrift,
        orphaned,
        note: "preview only — nothing was written; POST to reconcile",
      },
      { status: 200 },
    );
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
