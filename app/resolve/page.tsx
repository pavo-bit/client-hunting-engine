import Link from "next/link";
import { getPool } from "@/lib/intake/db";
import { getCandidateQueue } from "@/lib/resolve/engine";
import { getAgencies } from "@/lib/dashboard/queries";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { DecisionDialog } from "@/components/decision-dialog";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

const ruleTone: Record<string, "info" | "success" | "warning" | "default"> = {
  domain_exact: "info",
  registry_scoped: "success",
  alias: "info",
  name_exact: "warning",
};

export default async function ResolvePage() {
  await requireOperatorPage("/resolve");
  let queue = null;
  let counts = new Map<string, number>();
  try {
    const pool = getPool();
    [queue] = [await getCandidateQueue(pool, "pending")];
    const companies = await getAgencies("");
    for (const c of companies)
      counts.set(c.discovery_status, (counts.get(c.discovery_status) ?? 0) + 1);
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "Agency Intelligence" }, { label: "Resolution" }]} title="Identity Resolution" />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Agency Intelligence" }, { label: "Resolution" }]}
        title="Identity Resolution"
        description="Deterministic matching: jurisdiction-scoped registries, exact domains, verified aliases. Names alone never auto-merge; conflicting registries require human review."
      />
      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Records by status</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {[...counts.entries()].map(([s, n]) => (
                <li key={s} className="flex justify-between">
                  <span><Badge variant={s === "qualified" ? "success" : "default"}>{s}</Badge></span>
                  <span className="font-medium">{n}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>How matches are decided</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm text-slate-600">
            <p>Auto-merge: exact domain + compatible registries only (older record wins).</p>
            <p>Review: scoped-registry, alias, and exact-name matches; any registry conflict.</p>
            <p>Merges repoint all linked rows, preserve aliases, and write audit events.</p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle>Review queue ({queue.length} pending)</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Pending duplicate candidates"
            columns={["A", "B", "Rule", "Reason", "Impact", "Decide"]}
            rows={queue.map((k) => [
              <Link key="a" href={`/agencies/${k.id_a}`} className="text-blue-700 hover:underline">
                {k.name_a}
              </Link>,
              <Link key="b" href={`/agencies/${k.id_b}`} className="text-blue-700 hover:underline">
                {k.name_b}
              </Link>,
              <span key="r" className="inline-flex items-center gap-1">
                <Badge variant={ruleTone[k.rule] ?? "default"}>{k.rule}</Badge>
                {k.conflicting_registry && <Badge variant="danger">registry conflict</Badge>}
              </span>,
              <span key="d" className="text-xs text-slate-600">{k.detail}</span>,
              <span key="i">{k.linked_rows} linked rows move on merge</span>,
              <span key="x">
                <DecisionDialog
                  candidateId={k.id}
                  names={`${k.name_a} / ${k.name_b}`}
                  conflicting={k.conflicting_registry}
                  linkedRows={k.linked_rows}
                />
              </span>,
            ])}
            empty="Queue is empty. Run resolution from an agency detail page to generate deterministic candidates."
          />
        </CardContent>
      </Card>
    </div>
  );
}
