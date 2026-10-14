import { getAgencies } from "@/lib/dashboard/queries";
import { AgencyTable } from "@/components/agency-table";
import { PageHeader } from "@/components/page-header";
import { Alert, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export default async function AgenciesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireOperatorPage("/agencies");
  const { q } = await searchParams;
  const query = (q ?? "").trim();
  let rows: React.ComponentProps<typeof AgencyTable>["rows"] = [];
  let error: string | null = null;
  try {
    rows = await getAgencies(query);
  } catch {
    error = "Could not load agencies from the local database. Is Docker PostgreSQL running (docker compose up)?";
  }

  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Agency Intelligence" }, { label: "Directory" }]}
        title="Agency directory"
        description="Canonical agency records from intake. Worldwide scope; country is an attribute, not a restriction."
      />
      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              Agencies ({rows.length}{query ? ` matching “${query}”` : ""})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <AgencyTable rows={rows} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
