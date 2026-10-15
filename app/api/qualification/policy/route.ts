import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";
import {
  draftCapacity,
  draftPolicy,
  draftRubric,
  draftService,
  lintCapacity,
  lintPolicy,
  lintRubric,
  lintService,
  publishCapacity,
  publishCatalog,
  publishPolicy,
  publishRubric,
} from "@/lib/qualification/policy";
import { setReferenceStatus } from "@/lib/qualification/cases";

const KINDS = ["policy", "service_catalog", "rubric", "capacity"] as const;

/**
 * POST /api/qualification/policy — version lifecycle for policy content.
 * Body: { action: lint|draft|publish|retire, kind, version?, definition? }.
 * lint/draft validate without activating; publish activates an explicit draft;
 * retire moves active -> retired. Drafts never alter live rankings: nothing
 * reads drafts. Attribution is the session operator.
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
    const action = typeof body["action"] === "string" ? body["action"] : "";
    const kind = typeof body["kind"] === "string" ? body["kind"] : "";
    const version = typeof body["version"] === "string" ? body["version"].trim().slice(0, 80) : "";
    const definition = body["definition"] as Record<string, unknown>;
    if (!["lint", "draft", "publish", "retire"].includes(action)) {
      return NextResponse.json(
        { code: "bad_action", message: "action must be lint|draft|publish|retire" },
        { status: 422 },
      );
    }
    if (!(KINDS as readonly string[]).includes(kind)) {
      return NextResponse.json(
        { code: "bad_kind", message: "kind must be policy|service_catalog|rubric|capacity" },
        { status: 422 },
      );
    }
    const pool = getPool();
    const actor = auth.email ?? actorOf(body);
    if (action === "lint") {
      const lint =
        kind === "policy"
          ? lintPolicy(definition)
          : kind === "service_catalog"
            ? lintService(definition)
            : kind === "rubric"
              ? lintRubric(definition)
              : lintCapacity(definition);
      return NextResponse.json(lint.ok ? { ok: true } : { ok: false, problems: lint.problems }, { status: 200 });
    }
    if (action === "draft") {
      if (version === "") {
        return NextResponse.json({ code: "bad_version", message: "version is required" }, { status: 422 });
      }
      if (kind === "policy") await draftPolicy(pool, version, definition as never, actor);
      else if (kind === "service_catalog") {
        const defs = Array.isArray(definition) ? definition : [definition];
        for (const d of defs) await draftService(pool, version, d as never, actor);
      } else if (kind === "rubric") await draftRubric(pool, version, definition as never, actor);
      else await draftCapacity(pool, version, definition as never, actor);
      return NextResponse.json({ ok: true, version, status: "draft" }, { status: 201 });
    }
    if (version === "") {
      return NextResponse.json({ code: "bad_version", message: "version is required" }, { status: 422 });
    }
    if (action === "publish") {
      if (kind === "policy") await publishPolicy(pool, version, actor);
      else if (kind === "service_catalog") await publishCatalog(pool, version, actor);
      else if (kind === "rubric") await publishRubric(pool, version, actor);
      else await publishCapacity(pool, version, actor);
      return NextResponse.json({ ok: true, version, status: "active" }, { status: 200 });
    }
    await setReferenceStatus(pool, kind, version, "retired", actor);
    return NextResponse.json({ ok: true, version, status: "retired" }, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}

/** GET /api/qualification/policy — every version with status, newest first. Read-only. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireOperatorApi(req);
  if (!auth.ok) return auth.response!;
  try {
    const rows = await getPool().query(
      "select kind, version, status, recorded_by, recorded_at from p2.reference_version order by kind, recorded_at desc",
    );
    return NextResponse.json({ versions: rows.rows }, { status: 200 });
  } catch {
    return NextResponse.json({ code: "internal", message: "internal error" }, { status: 500 });
  }
}
