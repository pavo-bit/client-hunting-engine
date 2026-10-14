import Link from "next/link";
import { getImportBatches } from "@/lib/dashboard/queries";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { ImportWorkspace } from "@/components/import-workspace";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export default async function ImportRoutePage() {
  await requireOperatorPage("/import");
  let batches = null;
  try {
    batches = await getImportBatches();
  } catch {
    batches = null;
  }
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "System & Governance" }, { label: "Imports" }]}
        title="CSV import"
        description="Upload, server-side preview, then explicit confirmation. Max 5000 rows, CSV only. Prefer manual entry for single records."
        actions={
          <Link
            href="/agencies/new"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50"
          >
            Add agency manually
          </Link>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>Batch history ({batches?.length ?? "unavailable"})</CardTitle>
        </CardHeader>
        <CardContent>
          {batches === null ? (
            <Alert tone="error">History unavailable — database unreachable.</Alert>
          ) : (
            <SimpleTable
              caption="Import batches"
              columns={["File", "Rows", "Status", "Imported / skipped / invalid", "By", "Created"]}
              rows={batches.map((b) => [
                b.filename,
                String(b.total_rows),
                <Badge key="s" variant={b.status === "committed" ? "success" : "info"}>
                  {b.status}
                </Badge>,
                `${b.imported} / ${b.skipped} / ${b.invalid}`,
                b.created_by,
                new Date(b.created_at).toLocaleString(),
              ])}
              empty="No import batches yet."
            />
          )}
        </CardContent>
      </Card>
      <ImportWorkspace />
    </div>
  );
}
