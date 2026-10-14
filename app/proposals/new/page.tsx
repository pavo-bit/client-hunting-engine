import { PageHeader } from "@/components/page-header";
import { Alert, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProposalForm } from "@/components/proposal-form";
import { requireOperatorPage } from "@/lib/auth/guard";

export default async function NewProposalPage({
  searchParams,
}: {
  searchParams: Promise<{ hypothesis?: string }>;
}) {
  await requireOperatorPage("/proposals/new");
  const { hypothesis } = await searchParams;
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Evidence & Diagnosis" }, { label: "Proposals", href: "/projects" }, { label: "New" }]}
        title="Draft proposal"
        description="Explicit operator action on a validated hypothesis. The hypothesis must be validated first — anything else is rejected with guidance."
      />
      {!hypothesis ? (
        <Alert tone="warning">
          No hypothesis selected. Open a validated hypothesis and choose “Draft proposal” from there.
        </Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Proposal draft (hypothesis-linked)</CardTitle>
          </CardHeader>
          <CardContent>
            <ProposalForm hypothesisId={hypothesis} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
