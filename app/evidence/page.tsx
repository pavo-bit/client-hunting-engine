import Link from "next/link";
import { getClaims } from "@/lib/dashboard/queries";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { cn } from "@/lib/utils";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

const STATUSES = ["observed", "verified", "corroborated", "inferred", "assumed", "disputed", "withdrawn", "superseded"] as const;
const tone: Record<string, "info" | "success" | "warning" | "danger" | "default"> = {
  observed: "info",
  verified: "success",
  corroborated: "success",
  inferred: "warning",
  assumed: "danger",
  disputed: "warning",
  withdrawn: "default",
  superseded: "default",
};

export default async function EvidencePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireOperatorPage("/evidence");
  const { status } = await searchParams;
  let rows = null;
  try {
    rows = await getClaims(status);
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "Evidence & Diagnosis" }, { label: "Evidence" }]} title="Evidence Ledger" />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Evidence & Diagnosis" }, { label: "Evidence" }]}
        title="Evidence Ledger"
        description="Every claim with provenance, claim status, and freshness. Inferred and assumed claims are never presented as verified facts."
      />
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by claim status">
        <Link
          href="/evidence"
          className={cn("rounded-full border px-3 py-1 text-xs", !status ? "bg-slate-900 text-white" : "bg-white")}
        >
          all
        </Link>
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/evidence?status=${s}`}
            aria-current={status === s ? "true" : undefined}
            className={cn("rounded-full border px-3 py-1 text-xs", status === s ? "bg-slate-900 text-white" : "bg-white")}
          >
            {s}
          </Link>
        ))}
      </div>
      <Card>
        <CardHeader><CardTitle>Claims ({rows.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Evidence claims"
            columns={["Agency", "Claim", "Status", "Rel / Cred", "Source", "Freshness"]}
            rows={rows.map((c) => [
              <Link key={`a${c.id}`} href={`/evidence/${c.id}`} className="text-blue-700 hover:underline">
                {c.company_name}
              </Link>,
              <span key="t">{c.claim_text}</span>,
              <span key="s" className="inline-flex items-center gap-1">
                <Badge variant={tone[c.claim_status]}>{c.claim_status}</Badge>
                {c.stale && <Badge variant="danger">stale</Badge>}
              </span>,
              `${c.source_reliability} / ${c.info_credibility}`,
              <span key="p" className="break-all text-xs text-slate-600">
                {c.source_key} · {c.snapshot_url} · {new Date(c.fetched_at).toLocaleDateString()}
              </span>,
              c.expires_at ? `expires ${new Date(c.expires_at).toLocaleDateString()}` : "no expiry",
            ])}
            empty="No claims recorded."
          />
        </CardContent>
      </Card>
      <Alert tone="info">
        Reliability (source, A–D) and credibility (information, 1–5) are
        recorded separately on every claim. Stale claims must be refreshed
        before hypotheses relying on them can validate.
      </Alert>
    </div>
  );
}
