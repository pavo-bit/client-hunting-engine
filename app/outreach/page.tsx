import Link from "next/link";
import { getPool } from "@/lib/intake/db";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { CopyButton } from "@/components/copy-button";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

interface DraftListRow {
  id: string;
  brief_ref: string;
  company_name: string;
  channel: string;
  subject: string | null;
  body: string;
  status: string;
  version: number;
  unverified_points: string | null;
}

export default async function OutreachPage() {
  await requireOperatorPage("/outreach");
  let rows: DraftListRow[] = [];
  try {
    const r = await getPool().query(
      `select od.id, od.brief_ref, c.name as company_name, od.channel,
              od.subject, od.body, od.status, od.version, od.unverified_points
       from public.outreach_draft od
       join public.brief b on b.ref = od.brief_ref
       join public.company c on c.id = b.company_id
       order by od.created_at desc limit 500`,
    );
    rows = r.rows as DraftListRow[];
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "Sales Workspace" }, { label: "Outreach" }]} title="Outreach Drafts" />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Sales Workspace" }, { label: "Outreach" }]}
        title="Outreach Drafts"
        description="Copy-only drafts grounded in brief evidence. Review, revision, and approval happen on each brief's page; this index never sends, submits, or notifies."
      />
      <Alert tone="warning">
        Human-only boundary: there is deliberately no send action anywhere.
        Copy exists for moving text to your own mail client.
      </Alert>
      <Card>
        <CardHeader><CardTitle>All drafts ({rows.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Outreach drafts"
            columns={["Brief", "Agency", "Channel", "Status", "Unverified?", "Copy"]}
            rows={rows.map((d) => [
              <Link key={`b${d.id}`} href={`/briefs/${d.brief_ref}`} className="text-blue-700 hover:underline">
                {d.brief_ref} (v{d.version})
              </Link>,
              <span key={`c${d.id}`}>{d.company_name}</span>,
              <span key={`h${d.id}`}>{d.channel}</span>,
              <Badge
                key={`s${d.id}`}
                variant={d.status === "ready" ? "success" : "info"}
              >
                {d.status}
              </Badge>,
              d.unverified_points ? (
                <Badge key={`u${d.id}`} variant="warning">
                  approval blocked
                </Badge>
              ) : (
                <span key={`u${d.id}`}>—</span>
              ),
              <span key={`p${d.id}`}>
                <CopyButton text={d.body} label={`Copy draft for ${d.company_name}`} />
              </span>,
            ])}
            empty="No drafts prepared yet. Drafts are created from a brief page."
          />
        </CardContent>
      </Card>
    </div>
  );
}
