import { getSources } from "@/lib/dashboard/queries";
import { createRegistry } from "@/lib/discovery/registry";
import { AgencyDirectoryFixture } from "@/lib/discovery/fixtures/agency-directory";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  await requireOperatorPage("/sources");
  let rows = null;
  try {
    rows = await getSources();
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "System & Governance" }, { label: "Sources" }]} title="Source Registry" />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  // Framework adapters are code-registered (no network, no secrets).
  const framework = createRegistry([new AgencyDirectoryFixture()]).list();
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "System & Governance" }, { label: "Sources" }]}
        title="Source Registry"
        description="The 12 approved discovery categories with reliability priors and enablement. Automated adapters are not built (T-005+); enabled rows feed manual research today. Reddit and YouTube are excluded by policy."
      />
      <Card>
        <CardHeader><CardTitle>Categories ({rows.filter((r) => r.kind === "category").length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Source registry"
            columns={["Category", "Platform", "Reliability", "Enabled"]}
            rows={rows
              .filter((r) => r.kind === "category")
              .map((s) => [
                s.category,
                s.platform,
                `prior ${s.reliability_prior}`,
                s.enabled ? (
                  <Badge key="e" variant="success">enabled</Badge>
                ) : (
                  <Badge key="e" variant="default">disabled</Badge>
                ),
              ])}
            empty="No sources registered."
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Live connectors ({rows.filter((r) => r.kind === "connector").length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Live source connectors"
            columns={["Key", "Category", "Platform", "Reliability", "Enabled"]}
            rows={rows
              .filter((r) => r.kind === "connector")
              .map((s) => [
                <code key="k">{s.key}</code>,
                s.category,
                s.platform,
                `prior ${s.reliability_prior}`,
                s.enabled ? (
                  <Badge key="e" variant="success">enabled</Badge>
                ) : (
                  <Badge key="e" variant="default">disabled</Badge>
                ),
              ])}
            empty="No live connectors. Live sources require individual evaluation decisions."
          />
        </CardContent>
      </Card>
      <Alert tone="info">
        Access rules per category (official APIs only, rate limits, manual
        fallbacks) live in the source integration plan. No scraping runs from
        this dashboard; LinkedIn and social sources are permitted-means-only.
      </Alert>
      <Card>
        <CardHeader><CardTitle>Framework adapters ({framework.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Registered framework adapters"
            columns={["Adapter", "Category", "Version", "Capabilities", "Access"]}
            rows={framework.map((a) => [
              `${a.name} (${a.id})`,
              a.category,
              a.version,
              a.capabilities.join(", "),
              a.accessRequirements,
            ])}
            empty="No framework adapters registered."
          />
          <p className="mt-2 text-xs text-slate-500">
            Fixture only — synthetic records, no network, never registered in
            production code. Registration never executes an adapter; listing
            triggers no requests. Live adapters are individually evaluated
            tasks (T-006+), not implied by this registry.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
