import Link from "next/link";
import { getPool } from "@/lib/intake/db";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  await requireOperatorPage("/projects");
  let rows = null;
  try {
    const r = await getPool().query(
      `select p.id, p.title, p.status, p.version, p.effort_lo_days,
              p.effort_hi_days, p.cost_low, p.cost_high, p.cost_currency,
              p.confidence, p.created_at, c.name as company_name,
              h.title as hypothesis_title
       from public.project_option p
       join public.hypothesis h on h.id = p.hypothesis_id
       join public.company c on c.id = h.company_id
       order by p.created_at desc limit 500`,
    );
    rows = r.rows as {
      id: string;
      title: string;
      status: string;
      version: number;
      effort_lo_days: number | null;
      effort_hi_days: number | null;
      cost_low: string | null;
      cost_high: string | null;
      cost_currency: string | null;
      confidence: string | null;
      created_at: string;
      company_name: string;
      hypothesis_title: string;
    }[];
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "Evidence & Diagnosis" }, { label: "Projects" }]} title="Project Proposals" />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Evidence & Diagnosis" }, { label: "Projects" }]}
        title="Project Proposals"
        description="Structured, reviewable hypotheses about potential projects — never confirmed requirements. Draft one from a validated hypothesis."
      />
      <Card>
        <CardHeader><CardTitle>Proposals ({rows.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Project proposals"
            columns={["Proposal", "Agency", "Status", "Effort (days)", "Price", "Confidence"]}
            rows={rows.map((p) => [
              <span key={`t${p.id}`}>
                <Link href={`/proposals/${p.id}`} className="text-blue-700 hover:underline">
                  {p.title}
                </Link>{" "}
                <span className="text-xs text-slate-500">v{p.version}</span>
              </span>,
              <span key={`c${p.id}`}>{p.company_name}</span>,
              <Badge
                key={`s${p.id}`}
                variant={p.status === "accepted" ? "success" : p.status === "rejected" ? "danger" : "info"}
              >
                {p.status}
              </Badge>,
              <span key={`e${p.id}`}>
                {p.effort_lo_days != null ? `${p.effort_lo_days}–${p.effort_hi_days}` : "no estimate"}
              </span>,
              <span key={`p${p.id}`}>
                {p.cost_low != null ? `${p.cost_low}–${p.cost_high} ${p.cost_currency}` : "—"}
              </span>,
              <span key={`f${p.id}`}>{p.confidence ?? "—"}</span>,
            ])}
            empty="No proposals yet. Draft one from a validated hypothesis — nothing auto-generates."
          />
        </CardContent>
      </Card>
    </div>
  );
}
