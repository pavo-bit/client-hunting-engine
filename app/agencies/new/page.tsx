import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ManualForm } from "@/components/manual-form";
import { requireOperatorPage } from "@/lib/auth/guard";

export default async function NewAgencyPage() {
  await requireOperatorPage("/agencies/new");
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Agency Intelligence" }, { label: "Add Agency" }]}
        title="Add agency"
        description="Manual entry with server-side validation, domain normalization, and duplicate detection (409 on conflict)."
      />
      <Card>
        <CardHeader>
          <CardTitle>Agency details</CardTitle>
        </CardHeader>
        <CardContent>
          <ManualForm />
        </CardContent>
      </Card>
    </div>
  );
}
