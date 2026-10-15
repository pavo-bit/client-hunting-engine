import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";
import { getResearchTask, setResearchTaskDue, setResearchTaskStatus } from "@/lib/qualification/research";

/**
 * PATCH /api/qualification/research/[id] — operator workflow on a task.
 * Body may carry { status } (open->accepted|dismissed, accepted->done|dismissed,
 * dismissed->open), { dueAt } (ISO timestamp or null to clear the due flag),
 * and { notes? }. At least one of status/dueAt is required. Attribution is
 * the session operator.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireOperatorApi(req);
  if (!auth.ok) return auth.response!;
  const csrf = requireSameOrigin(req, auth);
  if (csrf) return csrf;
  const { id } = await ctx.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json(
      { code: "bad_id", message: "task id must be a uuid" },
      { status: 422 },
    );
  }
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
    const hasStatus = typeof body["status"] === "string" && body["status"] !== "";
    const hasDue = body["dueAt"] === null || typeof body["dueAt"] === "string";
    if (!hasStatus && !hasDue) {
      return NextResponse.json(
        { code: "bad_task_update", message: "supply status and/or dueAt (ISO timestamp or null)" },
        { status: 422 },
      );
    }
    const pool = getPool();
    const actor = auth.email ?? actorOf(body);
    if (hasDue) {
      await setResearchTaskDue(pool, id, body["dueAt"] === null ? null : (body["dueAt"] as string), actor);
    }
    if (hasStatus) {
      const task = await setResearchTaskStatus(
        pool,
        id,
        body["status"] as string,
        actor,
        typeof body["notes"] === "string" ? body["notes"] : undefined,
      );
      return NextResponse.json(task, { status: 200 });
    }
    const task = await getResearchTask(pool, id);
    if (!task) {
      return NextResponse.json({ code: "task_not_found", message: "research task not found" }, { status: 404 });
    }
    return NextResponse.json(task, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
