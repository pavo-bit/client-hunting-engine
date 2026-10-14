import { PageHeader } from "@/components/page-header";
import { Alert, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";

const DISCLOSURES: [string, string][] = [
  ["Operator authentication", "AUTH-001: email + password operator sign-in (/login), opaque server-side sessions in PostgreSQL (12h sliding, 24h absolute cap), HttpOnly SameSite=Lax cookies, rate-limited login, CSRF origin checks on cookie-authenticated mutations. Legacy bearer token is an explicit service credential only when OPERATOR_API_TOKEN is configured; empty never means open. Local-only; do not expose publicly."],
  ["Session & credential operations", "Provision with `node scripts/operator.mjs init` (never commit OPERATOR_PASSWORD_HASH). Rotate by re-provisioning + revoking sessions. Recovery: re-provision; all sessions revoke on next login. Logout revokes server-side."],
  ["Database access", "Server-side owner connection; RLS default-deny + revoked PUBLIC (verified). Unprivileged-role denial tested."],
  ["Remote Supabase", "Not linked. Local Docker stack only."],
  ["CSV import policy (D-007)", "5000 data rows/file, CSV only, preview + explicit confirm, server-enforced."],
  ["File safety cap", "10 MB provisional (T-003)."],
  ["Scoring weights (D-006)", "Provisional v0.1-PROVISIONAL; gates override scores."],
  ["Pricing (D-005)", "Undecided — commercial figures are ranges with assumptions only."],
  ["Capability catalog (D-004)", "Seed rows are placeholders; owner input required."],
  ["Snapshot retention (D-008)", "Undecided; per-class review pending."],
  ["Outreach", "Human-only. No send endpoints exist by design (tested)."],
  ["Excluded sources", "Reddit and YouTube — no adapters, no backlog."],
];

export default async function SettingsPage() {
  await requireOperatorPage("/settings");
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "System & Governance" }, { label: "Settings" }]}
        title="Settings & Access"
        description="Read-only disclosures. There are no editable settings in this build — controls that cannot act are omitted rather than faked."
      />
      <Alert tone="warning">
        Partial capability — authentication, retention windows, and hosted
        configuration require decisions and backend work. Nothing on this page
        is editable yet.
      </Alert>
      <Card>
        <CardHeader><CardTitle>Policy disclosures</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Policy disclosures"
            columns={["Area", "State"]}
            rows={DISCLOSURES.map(([a, s]) => [a, s])}
            empty="No disclosures."
          />
        </CardContent>
      </Card>
    </div>
  );
}
