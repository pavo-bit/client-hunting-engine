import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/intake/db";
import { getProposalDetail } from "@/lib/proposal/proposals";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { ProposalDecisionDialog } from "@/components/proposal-dialog";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireOperatorPage("/proposals/[id]");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let detail = null;
  try {
    detail = await getProposalDetail(getPool(), id);
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "Evidence & Diagnosis" }, { label: "Proposals", href: "/projects" }, { label: "Detail" }]} title="Proposal" />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  if (!detail) notFound();
  const p = detail.proposal as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" && v !== "" ? v : "—");

  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Evidence & Diagnosis" }, { label: "Proposals", href: "/projects" }, { label: `v${String(p.version)}` }]}
        title={String(p.title)}
        description="A structured, reviewable hypothesis about a potential project — not a confirmed requirement or commitment."
        actions={<ProposalDecisionDialog proposalId={String(p.id)} />}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={p.status === "accepted" ? "success" : p.status === "rejected" ? "danger" : "info"}>
          {String(p.status)}
        </Badge>
        <Badge variant="default">v{String(p.version)}</Badge>
        {detail.stale && <Badge variant="warning">evidence changed — review</Badge>}
      </div>
      {detail.stale && (
        <Alert tone="warning">
          Material evidence changed since this version: {detail.staleReasons.join("; ")}. Draft a new version or record a decision.
        </Alert>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Scope</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p><strong>In:</strong> {str(p.scope_in)}</p>
            <p><strong>Out (explicit exclusions):</strong> {str(p.scope_out)}</p>
            <p><strong>Milestones:</strong> {str(p.milestones)}</p>
            <p><strong>Dependencies:</strong> {str(p.dependencies)}</p>
            <p><strong>Feasibility:</strong> {str(p.feasibility)}{p.capability_fit ? ` — ${String(p.capability_fit)}` : ""}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Commercial (indicative only)</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>
              <strong>Effort:</strong>{" "}
              {p.effort_lo_days != null
                ? `${String(p.effort_lo_days)}–${String(p.effort_hi_days)} person-days (model v${String(p.estimation_version ?? "?")})`
                : "insufficient information — no estimate given"}
            </p>
            <p>
              <strong>Timeline:</strong>{" "}
              {p.timeline_lo_weeks != null
                ? `${String(p.timeline_lo_weeks)}–${String(p.timeline_hi_weeks)} weeks (operator assumption)`
                : "—"}
            </p>
            <p>
              <strong>Price:</strong>{" "}
              {p.cost_low != null
                ? `${String(p.cost_low)}–${String(p.cost_high)} ${String(p.cost_currency)} (${String(p.pricing_model ?? "model unspecified")})`
                : "—"}
            </p>
            <p><strong>Tax / third-party:</strong> {str(p.tax_note)}</p>
            <p><strong>Confidence:</strong> {str(p.confidence)}</p>
            <p><strong>Assumptions:</strong> {str(p.assumptions)}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Validation & questions</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p><strong>Must confirm with client:</strong> {str(p.validation_questions)}</p>
          <p><strong>Impact note:</strong> {str(p.impact_note)}</p>
          {p.decided_by ? (
            <p>
              <strong>Decided by {String(p.decided_by)}</strong>
              {p.decided_at ? ` on ${new Date(String(p.decided_at)).toLocaleString()}` : ""}:{" "}
              {str(p.decision_rationale)}
            </p>
          ) : (
            <p className="text-slate-500">No review decision recorded yet.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Version history ({detail.versions.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Proposal versions"
            columns={["Version", "Status", "Created"]}
            rows={detail.versions.map((v) => [
              v.id === p.id ? (
                <span key={v.id}>v{String(v.version)} (this)</span>
              ) : (
                <Link key={v.id} href={`/proposals/${v.id}`} className="text-blue-700 hover:underline">
                  v{String(v.version)}
                </Link>
              ),
              <span key={`s${v.id}`}>{v.status}</span>,
              <span key={`c${v.id}`}>{new Date(v.created_at).toLocaleString()}</span>,
            ])}
            empty="No versions."
          />
        </CardContent>
      </Card>
    </div>
  );
}
