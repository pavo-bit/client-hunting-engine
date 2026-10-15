import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi } from "@/lib/auth/guard";
import { assessmentStaleness } from "@/lib/qualification/assessments";
import { decisionHistory } from "@/lib/qualification/decisions";

/**
 * GET /api/qualification/cases/[id] — one case with snapshots, assessments,
 * research tasks and the latest assessment's staleness. All projections
 * except the staleness computation (read-only); never writes case state.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireOperatorApi(req);
  if (!auth.ok) return auth.response!;
  const { id } = await ctx.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json(
      { code: "bad_id", message: "case id must be a uuid" },
      { status: 422 },
    );
  }
  try {
    const pool = getPool();
    const kase = await pool.query("select * from p2.case where case_id = $1", [id]);
    if (kase.rows.length === 0) {
      return NextResponse.json({ code: "case_not_found", message: "qualification case not found" }, { status: 404 });
    }
    const snapshots = await pool.query(
      `select snapshot_id, schema_version, row_hash, captured_at, captured_by, captured_reason
       from p2.case_snapshot where case_id = $1 order by captured_at, snapshot_id`,
      [id],
    );
    const assessments = await pool.query(
      `select assessment_id, version, rubric_version, policy_version, service_catalog_version,
              capacity_version, as_of, snapshot_hash, code_version, input_snapshot_id,
              decided_by, decided_at, note
       from p2.case_assessment where case_id = $1 order by version`,
      [id],
    );
    const tasks = await pool.query(
      `select task_id, question, reason_code, dimension, gate, evidence_needed,
              expected_impact, uncertainty, source_availability, effort_estimate,
              priority_explanation, status, operator_notes, created_at
       from p2.research_task where case_id = $1 order by created_at, task_id`,
      [id],
    );
    const latest = assessments.rows[assessments.rows.length - 1] as { assessment_id: string } | undefined;
    const staleness = latest ? await assessmentStaleness(pool, latest.assessment_id) : null;
    const decisions = await decisionHistory(pool, id);
    return NextResponse.json(
      {
        case: kase.rows[0],
        snapshots: snapshots.rows,
        assessments: assessments.rows,
        research_tasks: tasks.rows,
        decisions,
        staleness,
      },
      { status: 200 },
    );
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
