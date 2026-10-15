import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";
import { todayData } from "@/lib/qualification/dashboard";

export const dynamic = "force-dynamic";

/**
 * GET /today — current priorities, blocked cases, research needing attention,
 * system-health warnings. Every section degrades to an honest empty state:
 * with no active policy the qualification sections say so instead of showing
 * an empty queue as if it meant "nothing to do".
 */
export default async function TodayPage() {
  await requireOperatorPage("/today");
  let data: Awaited<ReturnType<typeof todayData>> | null = null;
  let error: string | null = null;
  try {
    data = await todayData();
  } catch {
    error = "Local database unreachable.";
  }
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Command Center" }, { label: "Today" }]}
        title="Today"
        description="What deserves attention right now: pursuit priorities, blocked work, due research, and system health. Empty means empty — never hidden."
      />
      {error || !data ? (
        <Alert tone="error">{error ?? "Could not load."}</Alert>
      ) : (
        <>
          {!data.activePolicy && (
            <Alert tone="warning">
              No active qualification policy — pursuit ranking is paused by design (O10 open). Discovery,
              review and research below still work; nothing here invents scores.
            </Alert>
          )}
          {data.runningRuns > 0 && (
            <Alert tone="warning">
              {data.runningRuns} discovery run{data.runningRuns === 1 ? " is" : "s are"} still marked
              running — check /discovery and reap or await completion.
            </Alert>
          )}
          {data.unsettledInbox > 0 && (
            <Alert tone="warning">
              {data.unsettledInbox} claimed-but-unsettled event{data.unsettledInbox === 1 ? "" : "s"} in
              Phase 2 inboxes — run reconciliation from /admin.
            </Alert>
          )}
          <Card>
            <CardHeader><CardTitle>Top leads (latest eligible assessments)</CardTitle></CardHeader>
            <CardContent>
              <SimpleTable
                caption="Highest-composite eligible cases"
                columns={["Case", "Agency", "Composite", "Band", "Open"]}
                rows={data.topLeads.map((l) => [
                  <span key={`c${l.case_id}`} className="font-mono text-xs">{l.case_id.slice(0, 8)}</span>,
                  <span key={`n${l.case_id}`}>{l.company_name ?? "—"}</span>,
                  <span key={`s${l.case_id}`}>{l.composite}</span>,
                  <span key={`b${l.case_id}`}>
                    <Badge variant="default">{l.band ?? "unbanded"}</Badge>
                  </span>,
                  <Link key={`o${l.case_id}`} href={`/qualification/cases/${l.case_id}`} className="text-blue-700 hover:underline">
                    Open
                  </Link>,
                ])}
                empty="No eligible leads right now. That means none assessed eligible — not that the queue is broken."
              />
            </CardContent>
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Attention</CardTitle></CardHeader>
              <CardContent>
                <SimpleTable
                  caption="Items needing the operator"
                  columns={["Signal", "Count"]}
                  rows={[
                    ["Drifted cases (Discovery moved)", String(data.driftedCases)],
                    ["Open research tasks", String(data.openTasks)],
                    ["Overdue research tasks", String(data.overdueTasks.length)],
                  ]}
                  empty="Nothing needs attention."
                />
                {data.overdueTasks.length > 0 && (
                  <div className="mt-3">
                    <SimpleTable
                      caption="Overdue research"
                      columns={["Question", "Due", "Open"]}
                      rows={data.overdueTasks.map((t) => [
                        <span key={`q${t.task_id}`} className="block max-w-xl whitespace-pre-wrap text-xs">
                          {t.question}
                        </span>,
                        <span key={`d${t.task_id}`} className="text-xs text-red-700">
                          {new Date(t.due_at).toLocaleDateString()}
                        </span>,
                        <Link key={`o${t.task_id}`} href={`/qualification/cases/${t.case_id}`} className="text-blue-700 hover:underline">
                          Open case
                        </Link>,
                      ])}
                      empty="No overdue research."
                    />
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Recent human decisions</CardTitle></CardHeader>
              <CardContent>
                <SimpleTable
                  caption="Latest review decisions"
                  columns={["Case", "Decision", "Actor", "At"]}
                  rows={data.recentDecisions.map((d, i) => [
                    <Link key={`c${i}`} href={`/qualification/cases/${d.case_id}`} className="font-mono text-xs text-blue-700 hover:underline">
                      {d.case_id.slice(0, 8)}
                    </Link>,
                    <span key={`d${i}`}>
                      <Badge variant={d.decision === "accepted" ? "success" : d.decision === "rejected" ? "danger" : "default"}>
                        {d.decision}
                      </Badge>
                    </span>,
                    <span key={`a${i}`} className="text-xs">{d.actor}</span>,
                    <span key={`t${i}`} className="text-xs text-slate-600">
                      {new Date(d.decided_at).toLocaleString()}
                    </span>,
                  ])}
                  empty="No human decisions recorded yet."
                />
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
