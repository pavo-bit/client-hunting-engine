import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";
import { createResearchTask } from "@/lib/qualification/research";

/**
 * POST /api/qualification/research — manually initiate a research task.
 * Body: { caseId (uuid), snapshotId (uuid), question, reasonCode,
 *   dimension?, gate?, evidenceNeeded, expectedImpact (high|medium|low),
 *   uncertainty, sourceAvailability, effortEstimate (low|medium|high),
 *   priorityExplanation, dueAt? (iso|null) }.
 * Duplicate open questions for the case are refused (409). Attribution is
 * the session operator.
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
    const snapshotId = uuid(body["snapshotId"]);
    if (!caseId || !snapshotId) {
      return NextResponse.json(
        { code: "bad_id", message: "caseId and snapshotId must be uuids" },
        { status: 422 },
      );
    }
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    const task = await createResearchTask(getPool(), {
      caseId,
      snapshotId,
      question: str(body["question"]),
      reasonCode: str(body["reasonCode"]) || "OPERATOR_QUESTION",
      dimension: str(body["dimension"]) || null,
      gate: str(body["gate"]) || null,
      evidenceNeeded: str(body["evidenceNeeded"]),
      expectedImpact: str(body["expectedImpact"]) as "high" | "medium" | "low",
      uncertainty: str(body["uncertainty"]),
      sourceAvailability: str(body["sourceAvailability"]),
      effortEstimate: str(body["effortEstimate"]) as "low" | "medium" | "high",
      priorityExplanation: str(body["priorityExplanation"]),
      dueAt: body["dueAt"] === null ? null : str(body["dueAt"]) || undefined,
      actor: auth.email ?? actorOf(body),
    });
    return NextResponse.json(task, { status: 201 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
