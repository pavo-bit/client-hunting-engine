import { getProjects } from "@/lib/dashboard/queries";
import { PageHeader } from "@/components/page-header";
import { Alert, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export default async function CommercialPage() {
  await requireOperatorPage("/commercial");
  let rows = null;
  try {
    rows = await getProjects();
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "Evaluation & Review" }, { label: "Commercial" }]} title="Commercial Evaluation" />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Evaluation & Review" }, { label: "Commercial" }]}
        title="Commercial Evaluation"
        description="Only ranges and assumptions recorded on project proposals. No budgets, revenue, ROI, or delivery estimates are invented — pricing policy is undecided (D-005)."
      />
      <Alert tone="warning">
        Partial capability — figures below are estimate ranges with stated
        assumptions. Confirm every number with the agency in a human-led
        conversation before quoting.
      </Alert>
      <Card>
        <CardHeader><CardTitle>Commercial ranges ({rows.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Commercial ranges per project option"
            columns={["Agency", "Proposal", "Effort (days)", "Cost range", "Assumptions"]}
            rows={rows.map((p) => [
              p.company_name,
              p.title,
              `${p.effort_lo_days ?? "?"}–${p.effort_hi_days ?? "?"}`,
              p.cost_low && p.cost_high
                ? `${p.cost_low}–${p.cost_high} ${p.cost_currency}`
                : "TBD",
              p.assumptions,
            ])}
            empty="No project proposals with commercial ranges yet."
          />
        </CardContent>
      </Card>
    </div>
  );
}
