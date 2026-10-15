import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";
import { getPool } from "@/lib/intake/db";
import { TaskControls } from "@/components/qualification/task-controls";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

function displayStatus(task: Record<string, unknown>, negCount: number): string {
  const status = task.status as string;
  if (status === "dismissed") return "Cancelled";
  if (status === "done") return negCount > 0 ? "DoneNoneFound" : "DoneFound";
  const due = task.due_at ? new Date(task.due_at as string) : null;
  if ((status === "open" || status === "accepted") && due && due <= new Date()) return "Expired (overdue)";
  return status === "open" ? "Open" : "InProgress";
}

/**
 * GET /qualification/research — research workspace. Questions ranked by
 * decision value relative to effort; DoneFound vs DoneNoneFound and Expired
 * derive at read time from linked records and due flags (the frozen four
 * statuses are unchanged). All research is manually initiated and worked.
 */
export default async function ResearchPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; overdue?: string; offset?: string }>;
}) {
  await requireOperatorPage("/qualification/research");
  const sp = await searchParams;
  const status = (sp.status ?? "").trim();
  const overdueOnly = (sp.overdue ?? "").trim() === "true";
  const parsedOffset = Number.parseInt(sp.offset ?? "0", 10);
  const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;

  const pool = getPool();
  const conds: string[] = [];
  const params: unknown[] = [];
  const valid = ["open", "accepted", "done", "dismissed"];
  let error: string | null = null;
  if (status !== "" && !valid.includes(status)) error = "status must be open, accepted, done or dismissed.";
  if (!error) {
    if (status !== "") {
      params.push(status);
      conds.push(`t.status = $${params.length}`);
    }
    if (overdueOnly) conds.push("t.status in ('open','accepted') and t.due_at is not null and t.due_at <= now()");
  }
  const where = conds.length > 0 ? `where ${conds.join(" and ")}` : "";
  let total = 0;
  let rows: Record<string, unknown>[] = [];
  if (!error) {
    try {
      const n = await pool.query(`select count(*)::int as n from p2.research_task t ${where}`, params);
      total = (n.rows[0] as { n: number }).n;
      // Decision-value order: high impact first, then low effort, then oldest.
      const r = await pool.query(
        `select t.task_id, t.case_id, c.case_ref, t.question, t.reason_code, t.dimension, t.gate,
                t.evidence_needed, t.expected_impact, t.uncertainty, t.source_availability,
                t.effort_estimate, t.priority_explanation, t.status, t.operator_notes, t.due_at, t.created_at,
                (select count(*)::int from p2.negative_finding n where n.case_id = t.case_id and n.snapshot_id = t.snapshot_id) as neg_findings
         from p2.research_task t join p2.case c on c.case_id = t.case_id ${where}
         order by case t.expected_impact when 'high' then 0 when 'medium' then 1 else 2 end,
                  case t.effort_estimate when 'low' then 0 when 'medium' then 1 else 2 end,
                  t.created_at asc, t.task_id asc
         limit $${params.length + 1} offset $${params.length + 2}`,
        [...params, PAGE_SIZE, offset],
      );
      rows = r.rows as Record<string, unknown>[];
    } catch {
      error = "Could not load research tasks from the local database.";
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Qualification" }, { label: "Research" }]}
        title="Research workspace"
        description="Unanswered questions ordered by decision value relative to effort. Priority is an ordering aid — never a probability or a value claim. All research is manual."
      />
      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : (
        <Card>
          <CardHeader><CardTitle>Questions — {total}</CardTitle></CardHeader>
          <CardContent>
            <div className="mb-3 flex flex-wrap gap-3 text-sm">
              <Link href="/qualification/research" className="text-blue-700 hover:underline">All</Link>
              <Link href="/qualification/research?status=open" className="text-blue-700 hover:underline">Open</Link>
              <Link href="/qualification/research?status=accepted" className="text-blue-700 hover:underline">In progress</Link>
              <Link href="/qualification/research?overdue=true" className="text-blue-700 hover:underline">Overdue</Link>
            </div>
            {rows.map((t) => (
              <div key={t.task_id as string} className="mb-4 rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={(t.status as string) === "done" ? "success" : "default"}>
                    {displayStatus(t, t.neg_findings as number)}
                  </Badge>
                  <span className="text-xs text-slate-500">
                    {t.reason_code as string} · affects {String((t.dimension as string | null) ?? (t.gate as string ?? "?"))} ·{" "}
                    {t.expected_impact as string} impact / {t.effort_estimate as string} effort
                  </span>
                  <Link href={`/qualification/cases/${t.case_id as string}`} className="text-xs text-blue-700 hover:underline">
                    {(t.case_ref as string) ?? (t.case_id as string).slice(0, 8)}
                  </Link>
                </div>
                <p className="mt-1 text-sm">{t.question as string}</p>
                <p className="mt-1 text-xs text-slate-600">
                  <span className="font-medium">Evidence needed:</span> {t.evidence_needed as string}
                </p>
                <p className="text-xs text-slate-600">
                  <span className="font-medium">Why it matters:</span> {t.priority_explanation as string}
                </p>
                <p className="text-xs text-slate-600">
                  <span className="font-medium">Uncertainty:</span> {t.uncertainty as string} ·{" "}
                  <span className="font-medium">Sources:</span> {t.source_availability as string}
                </p>
                <div className="mt-2">
                  <TaskControls
                    taskId={t.task_id as string}
                    status={t.status as string}
                    dueAt={t.due_at ? (t.due_at as Date).toISOString() : null}
                  />
                </div>
              </div>
            ))}
            {rows.length === 0 && (
              <p className="text-sm text-slate-500">
                No research questions match. Assessments propose them automatically; the decision to research is always yours.
              </p>
            )}
            {(offset > 0 || offset + rows.length < total) && (
              <nav aria-label="Research pagination" className="mt-3 flex items-center gap-3 text-sm">
                {offset > 0 && (
                  <Link href={`/qualification/research?offset=${Math.max(0, offset - PAGE_SIZE)}`} className="text-blue-700 hover:underline">
                    ← Previous
                  </Link>
                )}
                <span className="text-slate-600">
                  Showing {total === 0 ? 0 : offset + 1}–{offset + rows.length} of {total}
                </span>
                {offset + rows.length < total && (
                  <Link href={`/qualification/research?offset=${offset + PAGE_SIZE}`} className="text-blue-700 hover:underline">
                    Next →
                  </Link>
                )}
              </nav>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
