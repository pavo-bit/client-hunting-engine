import { getAudit, getFailures } from "@/lib/dashboard/queries";
import { PageHeader } from "@/components/page-header";
import { Alert, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  await requireOperatorPage("/activity");
  let audit = null;
  let failures = null;
  try {
    [audit, failures] = await Promise.all([getAudit(), getFailures()]);
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "Command Center" }, { label: "Activity" }]} title="Activity & Status" />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Command Center" }, { label: "Activity" }]}
        title="Activity & Status"
        description="Append-only audit trail (latest 200) and open failure records. Test-generated rows are labeled by their actor."
      />
      <Card>
        <CardHeader><CardTitle>Failures ({failures.filter((f) => !f.resolved).length} open)</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Failure log"
            columns={["When", "Entity", "Cause", "Detail", "State"]}
            rows={failures.map((f) => [
              new Date(f.occurred_at).toLocaleString(),
              `${f.entity_type} ${f.entity_id?.slice(0, 8) ?? "—"}`,
              f.cause_class,
              f.detail ?? "—",
              <Badge key="s" variant={f.resolved ? "success" : "danger"}>
                {f.resolved ? "resolved" : "open"}
              </Badge>,
            ])}
            empty="No failures recorded."
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Recent audit events (20 latest — full trail under Audit &amp; Failures)</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Audit log"
            columns={["When", "Actor", "Entity", "Transition", "Reason"]}
            rows={audit.slice(0, 20).map((a) => [
              new Date(a.created_at).toLocaleString(),
              a.actor,
              `${a.entity_type} ${a.entity_id.slice(0, 8)}…`,
              `${a.transition_from ?? "∅"} → ${a.transition_to ?? "∅"}`,
              a.reason ?? "—",
            ])}
            empty="No audit events yet."
          />
        </CardContent>
      </Card>
    </div>
  );
}
