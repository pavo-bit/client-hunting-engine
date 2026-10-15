import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";
import { decide } from "@/lib/qualification/decisions";
import { readPolicy } from "@/lib/qualification/policy";

/**
 * POST /api/qualification/decisions — record a human review decision.
 * Body: { caseId (uuid), assessmentId? (uuid; required except withdrawn),
 *   type (accepted|rejected|deferred|withdrawn), reason (required),
 *   reasonCode?, resumeAt? (iso), resumeCondition?, idempotencyKey? }.
 * Backend-enforced: suppression/gate/staleness/conflict rules all apply;
 * the UI may mirror them but never enforces. Attribution is the session
 * operator. Idempotency keys are caller-chosen labels for the operator's own
 * retry safety (the uniqueness rule is per case+assessment, enforced by the
 * database with a 409 on conflict).
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
    const uuid = (v: unknown): string | null =>
      typeof v === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
        ? v
        : null;
    const caseId = uuid(body["caseId"]);
    if (!caseId) {
      return NextResponse.json({ code: "bad_id", message: "caseId must be a uuid" }, { status: 422 });
    }
    const assessmentId = body["assessmentId"] === undefined || body["assessmentId"] === null
      ? null
      : uuid(body["assessmentId"]);
    if (body["assessmentId"] !== undefined && body["assessmentId"] !== null && !assessmentId) {
      return NextResponse.json(
        { code: "bad_id", message: "assessmentId must be a uuid" },
        { status: 422 },
      );
    }
    const type = typeof body["type"] === "string" ? body["type"] : "";
    // Deferral limits come from the ACTIVE policy when one exists; without
    // one, structural rules still apply and numeric limits are skipped.
    const pool = getPool();
    let policy = null;
    try {
      const active = await pool.query(
        "select version from p2.reference_version where kind = 'policy' and status = 'active' order by recorded_at desc limit 1",
      );
      if (active.rows[0]?.version) policy = await readPolicy(pool, active.rows[0].version as string);
    } catch {
      policy = null;
    }
    const decision = await decide(pool, {
      caseId,
      assessmentId,
      type: type as "accepted" | "rejected" | "deferred" | "withdrawn",
      reason: typeof body["reason"] === "string" ? body["reason"] : "",
      reasonCode: typeof body["reasonCode"] === "string" ? body["reasonCode"] : undefined,
      resumeAt: typeof body["resumeAt"] === "string" ? body["resumeAt"] : undefined,
      resumeCondition: typeof body["resumeCondition"] === "string" ? body["resumeCondition"] : undefined,
      actor: auth.email ?? actorOf(body),
      policy,
    });
    return NextResponse.json(decision, { status: 201 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
