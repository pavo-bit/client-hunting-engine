import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";
import { activePolicyVersion } from "@/lib/qualification/policy";
import { runAssessment } from "@/lib/qualification/assessments";

/**
 * POST /api/qualification/assess — run one qualification assessment.
 * Body: { opportunityId (uuid, required), policyVersion?, catalogVersion?,
 *   rubricVersion?, capacityVersion?, operatorAnswers?, asOf?, requiredUsable?,
 *   idempotencyKey? }.
 * Omitted versions resolve to the ACTIVE version of each kind; when none is
 * active the run is refused (409) — an invented default is never substituted.
 * Executes synchronously in request scope (existing single-operator pattern).
 * A repeated idempotency key replays the recorded assessment.
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
    const opportunityId = typeof body["opportunityId"] === "string" ? body["opportunityId"] : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opportunityId)) {
      return NextResponse.json(
        { code: "bad_id", message: "opportunityId must be a uuid" },
        { status: 422 },
      );
    }
    const pool = getPool();
    const resolveActive = async (
      kind: "policy" | "service_catalog" | "rubric" | "capacity",
      given: unknown,
    ): Promise<string | null> => {
      if (typeof given === "string" && given.trim() !== "") return given.trim().slice(0, 80);
      if (kind === "policy") return activePolicyVersion(pool);
      const r = await pool.query(
        "select version from p2.reference_version where kind = $1 and status = 'active' order by recorded_at desc limit 1",
        [kind],
      );
      return (r.rows[0]?.version as string | undefined) ?? null;
    };
    const policyVersion = await resolveActive("policy", body["policyVersion"]);
    const catalogVersion = await resolveActive("service_catalog", body["catalogVersion"]);
    const rubricVersion = await resolveActive("rubric", body["rubricVersion"]);
    const capacityVersion = await resolveActive("capacity", body["capacityVersion"]);
    const missing = [
      ["policyVersion", policyVersion],
      ["catalogVersion", catalogVersion],
      ["rubricVersion", rubricVersion],
    ].filter(([, v]) => !v);
    if (missing.length > 0) {
      return NextResponse.json(
        {
          code: "no_active_reference",
          message: `no active ${missing.map(([k]) => k).join(", ")} — publish one explicitly before assessing`,
        },
        { status: 409 },
      );
    }
    const answers = body["operatorAnswers"];
    const result = await runAssessment(pool, {
      opportunityId,
      policyVersion: policyVersion as string,
      catalogVersion: catalogVersion as string,
      rubricVersion: rubricVersion as string,
      capacityVersion,
      operatorAnswers:
        answers !== undefined && answers !== null && typeof answers === "object"
          ? (answers as Record<string, unknown>)
          : {},
      asOf: typeof body["asOf"] === "string" ? body["asOf"] : undefined,
      requiredUsable:
        typeof body["requiredUsable"] === "number" ? body["requiredUsable"] : undefined,
      actor: auth.email ?? actorOf(body),
      idempotencyKey: typeof body["idempotencyKey"] === "string" ? body["idempotencyKey"] : undefined,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
