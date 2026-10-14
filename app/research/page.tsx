import { getResearchRuns, getSnapshots } from "@/lib/dashboard/queries";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

const short = (s: string) => `${s.slice(0, 12)}…`;

export default async function ResearchPage() {
  await requireOperatorPage("/research");
  let runs = null;
  let snaps = null;
  try {
    [runs, snaps] = await Promise.all([getResearchRuns(), getSnapshots()]);
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "Agency Intelligence" }, { label: "Research" }]} title="Research Workspace" />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Agency Intelligence" }, { label: "Research" }]}
        title="Research Workspace"
        description="Research runs and immutable source snapshots (metadata + short excerpt). Automated fetching is not built; snapshots are recorded alongside manual research."
      />
      <Card>
        <CardHeader><CardTitle>Research runs ({runs.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Research runs"
            columns={["Agency", "Status", "Failure class", "Attempts", "Started"]}
            rows={runs.map((r) => [
              r.company_name,
              <Badge key="s" variant={r.status === "ok" ? "success" : r.status === "failed" ? "danger" : "warning"}>
                {r.status}
              </Badge>,
              r.failure_class ?? "—",
              String(r.attempts),
              new Date(r.started_at).toLocaleString(),
            ])}
            empty="No research runs recorded."
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Snapshots ({snaps.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Source snapshots"
            columns={["Agency", "Source", "URL", "SHA-256", "Fetched", "Excerpt"]}
            rows={snaps.map((s) => [
              s.company_name,
              s.source_key,
              <span key="u" className="break-all">{s.suppressed ? "(suppressed — takedown)" : s.url}</span>,
              <code key="h">{short(s.sha256)}</code>,
              new Date(s.fetched_at).toLocaleString(),
              <q key="e" className="text-slate-600">{s.excerpt ?? "—"}</q>,
            ])}
            empty="No snapshots recorded."
          />
        </CardContent>
      </Card>
    </div>
  );
}
