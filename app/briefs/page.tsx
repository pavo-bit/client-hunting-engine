import Link from "next/link";
import { getBriefs } from "@/lib/dashboard/queries";
import { PageHeader } from "@/components/page-header";
import { Alert, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export default async function BriefsPage() {
  await requireOperatorPage("/briefs");
  let rows = null;
  try {
    rows = await getBriefs();
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "Sales Workspace" }, { label: "Briefs" }]} title="Opportunity Briefs" />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Sales Workspace" }, { label: "Briefs" }]}
        title="Opportunity Briefs"
        description="Frozen review packages: evidence, project options, commercial ranges, contradictions, and provenance."
      />
      <Card>
        <CardHeader><CardTitle>All briefs ({rows.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Opportunity briefs"
            columns={["Ref", "Agency", "Status", "Created"]}
            rows={rows.map((b) => [
              <Link key="r" href={`/briefs/${b.ref}`} className="text-blue-700 hover:underline">
                {b.ref}
              </Link>,
              b.company_name,
              b.status,
              new Date(b.created_at).toLocaleDateString(),
            ])}
            empty="No briefs yet. Briefs are assembled from validated hypotheses during review."
          />
        </CardContent>
      </Card>
    </div>
  );
}
