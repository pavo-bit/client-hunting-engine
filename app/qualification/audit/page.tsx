import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";
import { auditMetrics } from "@/lib/qualification/dashboard";

export const dynamic = "force-dynamic";

/**
 * GET /qualification/audit — decisions, gate outcomes, staleness, drift,
 * research load and evaluation pointers. Read-only; the numbers below are
 * live projections with stated denominators, not sampled claims.
 */
export default async function QualificationAuditPage() {
  await requireOperatorPage("/qualification/audit");
  let m: Awaited<ReturnType<typeof auditMetrics>> | null = null;
  let error: string | null = null;
  try {
    m = await auditMetrics();
  } catch {
    error = "Local database unreachable.";
  }
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Qualification" }, { label: "Audit & metrics" }]}
        title="Decisions, integrity, evaluation"
        description="What humans decided, what the gates say, where truth moved, and how the engine is measured. Denominators stated; unmeasured metrics named, not hidden."
      />
      {error || !m ? (
        <Alert tone="error">{error ?? "Could not load."}</Alert>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Human decisions ({m.decisionsByType.reduce((a, r) => a + r.n, 0)})</CardTitle></CardHeader>
              <CardContent>
                <SimpleTable
                  caption="Decisions by type (all recorded decisions)"
                  columns={["Decision", "Count"]}
                  rows={m.decisionsByType.map((r) => [
                    <span key={`d${r.decision}`}>
                      <Badge variant={r.decision === "accepted" ? "success" : r.decision === "rejected" ? "danger" : "default"}>
                        {r.decision}
                      </Badge>
                    </span>,
                    <span key={`n${r.decision}`}>{r.n}</span>,
                  ])}
                  empty="No human decisions recorded yet."
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Latest gate outcomes ({m.assessmentsTotal} assessments)</CardTitle></CardHeader>
              <CardContent>
                <SimpleTable
                  caption="Latest assessment outcome per case"
                  columns={["Outcome", "Cases"]}
                  rows={m.gateOutcomes.map((r) => [
                    <span key={`o${r.outcome}`}>{r.outcome}</span>,
                    <span key={`n${r.outcome}`}>{r.n}</span>,
                  ])}
                  empty="No assessments recorded yet."
                />
              </CardContent>
            </Card>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Integrity warnings</CardTitle></CardHeader>
              <CardContent>
                <SimpleTable
                  caption="Staleness, drift and overdue work"
                  columns={["Signal", "Count"]}
                  rows={[
                    ["Assessments whose evidence moved (stale)", String(m.staleAssessed)],
                    ["Drifted cases (Discovery moved)", String(m.drifted)],
                    ["Overdue research tasks", String(m.overdueTasks)],
                  ]}
                  empty="No integrity data."
                />
                <p className="mt-2 text-xs text-slate-500">
                  Stale assessments cannot back accept/defer — re-run them from the case page or /qualification/assess.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Research load</CardTitle></CardHeader>
              <CardContent>
                <SimpleTable
                  caption="Research tasks by status"
                  columns={["Status", "Count"]}
                  rows={m.tasksByStatus.map((r) => [
                    <span key={`s${r.status}`}>{r.status}</span>,
                    <span key={`n${r.status}`}>{r.n}</span>,
                  ])}
                  empty="No research tasks."
                />
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader><CardTitle>Evaluation harness</CardTitle></CardHeader>
            <CardContent>
              <p className="text-sm text-slate-600">
                Engine quality is measured against a versioned gold set with pre-declared thresholds and
                baselines — never tuned on the held-out split. Latest generated report:{" "}
                <span className="font-mono text-xs">docs/EVALUATION_BASELINE_REPORT.md</span> (operator runs{" "}
                <span className="font-mono text-xs">node scripts/evaluate.mjs --target test</span> to reproduce).
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Unmeasured until observed in operation (capture mechanisms defined in the handover): operator
                review time, pursuit-to-conversation rate, qualified-opportunity rate, research decision-change rate.
              </p>
              <Link href="/admin" className="text-sm text-blue-700 hover:underline">
                Administration and recovery →
              </Link>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
