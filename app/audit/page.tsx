import { getAudit, getFailures } from "@/lib/dashboard/queries";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  await requireOperatorPage("/audit");
  let audit = null;
  let failures = null;
  try {
    [audit, failures] = await Promise.all([getAudit(), getFailures()]);
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "System & Governance" }, { label: "Audit" }]} title="Audit & Failures" />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  const causes = new Map<string, number>();
  for (const f of failures) causes.set(f.cause_class, (causes.get(f.cause_class) ?? 0) + 1);
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "System & Governance" }, { label: "Audit" }]}
        title="Audit & Failures"
        description="Governance trail: append-only audit events, failure log, and data-integrity limits."
      />
      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Failures by cause</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {[...causes.entries()].length === 0 && <li>No failures recorded.</li>}
              {[...causes.entries()].map(([c, n]) => (
                <li key={c} className="flex justify-between">
                  <span>{c}</span><span className="font-medium">{n}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Integrity limits</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm text-slate-600">
            <p>Audit rows reject UPDATE/DELETE for granted roles (trigger-enforced).</p>
            <p>Limitation: table owners and superusers can still alter data — tamper-evidence, not absolute immutability.</p>
            <p>Snapshot retention windows undecided (D-008); snapshots show suppression state on takedown.</p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle>Failure log ({failures.length})</CardTitle></CardHeader>
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
        <CardHeader><CardTitle>Full audit trail ({audit.length}, bounded)</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Full audit trail"
            columns={["When", "Actor", "Entity", "Transition", "Reason"]}
            rows={audit.map((a) => [
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
