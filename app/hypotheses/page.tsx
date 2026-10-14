import Link from "next/link";
import { getHypotheses } from "@/lib/dashboard/queries";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { cn } from "@/lib/utils";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

const STATUSES = ["generated", "needs_review", "deferred", "rejected", "validated", "superseded"] as const;

export default async function HypothesesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireOperatorPage("/hypotheses");
  const { status } = await searchParams;
  let rows = null;
  try {
    rows = await getHypotheses();
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "Evidence & Diagnosis" }, { label: "Hypotheses" }]} title="Opportunity Hypotheses" />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  const shown = status ? rows.filter((h) => h.status === status) : rows;
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Evidence & Diagnosis" }, { label: "Hypotheses" }]}
        title="Opportunity Hypotheses"
        description="Reasoned possibilities, not established facts. Generate them from an agency page; every row traces to a deterministic rule version and linked evidence."
      />
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by hypothesis status">
        <Link
          href="/hypotheses"
          className={cn("rounded-full border px-3 py-1 text-xs", !status ? "bg-slate-900 text-white" : "bg-white")}
        >
          all
        </Link>
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/hypotheses?status=${s}`}
            aria-current={status === s ? "true" : undefined}
            className={cn("rounded-full border px-3 py-1 text-xs", status === s ? "bg-slate-900 text-white" : "bg-white")}
          >
            {s}
          </Link>
        ))}
      </div>
      <Card>
        <CardHeader><CardTitle>Hypotheses ({shown.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Opportunity hypotheses"
            columns={["Agency", "Hypothesis", "Rule", "Status", "Evidence ±"]}
            rows={shown.map((h) => [
              h.company_name,
              <Link key={`t${h.id}`} href={`/hypotheses/${h.id}`} className="text-blue-700 hover:underline">
                {h.title}
              </Link>,
              <code key={`r${h.id}`} className="text-xs">
                {h.rule_id ? `${h.rule_id} v${h.rule_version ?? "?"}` : "—"}
              </code>,
              <Badge
                key={`s${h.id}`}
                variant={h.status === "validated" ? "success" : h.status === "rejected" ? "danger" : "info"}
              >
                {h.status}
              </Badge>,
              `+${h.supports} / −${h.contradicts}`,
            ])}
            empty="No hypotheses recorded. Generate them from an agency detail page — the engine stays silent without sufficient evidence."
          />
        </CardContent>
      </Card>
    </div>
  );
}
