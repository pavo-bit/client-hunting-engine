import { getPool } from "@/lib/intake/db";
import { listCapabilities } from "@/lib/sales/catalog";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { CatalogStatusButton } from "@/components/catalog-dialog";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export default async function CatalogPage() {
  await requireOperatorPage("/catalog");
  let rows = null;
  try {
    rows = await listCapabilities(getPool());
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "System & Governance" }, { label: "Catalog" }]} title="Service Catalog" />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "System & Governance" }, { label: "Catalog" }]}
        title="Service Catalog"
        description="Structure is implemented; commercial content needs the owner (D-004). Draft entries are never presented as approved offerings — briefs label them explicitly."
      />
      <Alert tone="warning">
        {rows.filter((r) => r.status !== "approved").length} of {rows.length} entries
        await owner review. Approving means asserting Grayscales can deliver it —
        record who decided and why. Full owner checklist lives in the
        repository at <code>docs/T010_OWNER_DECISIONS.md</code>; policy state
        is summarized under <a href="/settings" className="underline">Settings</a>.
      </Alert>
      <Card>
        <CardHeader><CardTitle>Capabilities ({rows.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Service catalog"
            columns={["Key", "Name", "Entry criteria", "Status", "Set status"]}
            rows={rows.map((r) => [
              <code key={`k${r.key}`}>{r.key}</code>,
              <span key={`n${r.key}`}>
                {r.name}{" "}
                {r.is_placeholder && <Badge variant="warning">placeholder</Badge>}
              </span>,
              <span key={`e${r.key}`}>{r.entry_criteria ?? "—"}</span>,
              <Badge
                key={`s${r.key}`}
                variant={r.status === "approved" ? "success" : "warning"}
              >
                {r.status}
              </Badge>,
              <span key={`b${r.key}`}>
                <CatalogStatusButton capKey={r.key} current={r.status} />
              </span>,
            ])}
            empty="Catalog is empty. Additions are owner content work, not automation."
          />
        </CardContent>
      </Card>
    </div>
  );
}
