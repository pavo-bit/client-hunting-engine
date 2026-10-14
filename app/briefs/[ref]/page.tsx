import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/intake/db";
import { getBriefWorkspace } from "@/lib/sales/briefs";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { CopyButton } from "@/components/copy-button";
import {
  BriefDecisionDialog,
  OutcomeForm,
  PipelineDialog,
  StageBadge,
} from "@/components/sales-dialogs";
import { DraftWorkspace } from "@/components/draft-workspace";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export default async function BriefDetailPage({
  params,
}: {
  params: Promise<{ ref: string }>;
}) {
  await requireOperatorPage("/briefs/[ref]");
  const { ref } = await params;
  if (!/^BR-[0-9]{4}-[0-9]{3,}$/.test(decodeURIComponent(ref))) notFound();
  let ws = null;
  try {
    ws = await getBriefWorkspace(getPool(), decodeURIComponent(ref));
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "Sales Workspace" }, { label: "Briefs", href: "/briefs" }, { label: ref }]} title={ref} />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  if (!ws) notFound();
  const b = ws.brief as Record<string, unknown>;
  const p = ws.proposal as Record<string, unknown> | null;

  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Sales Workspace" }, { label: "Briefs", href: "/briefs" }, { label: String(b.ref) }]}
        title={`Brief ${String(b.ref)}`}
        description="Internal opportunity brief — evidence, proposal, and human-recorded sales state. Nothing here contacts anyone."
        actions={<BriefDecisionDialog briefRef={String(b.ref)} />}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={b.status === "approved" ? "success" : b.status === "rejected" ? "danger" : "info"}>
          {String(b.status)}
        </Badge>
        <StageBadge stage={(b.pipeline_stage as string | null) ?? null} />
        {ws.stale && <Badge variant="warning">stale — review</Badge>}
      </div>
      {ws.stale && (
        <Alert tone="warning">
          Flagged for review: {ws.staleReasons.join("; ")}. History below is preserved; record a new decision when resolved.
        </Alert>
      )}

      <Card>
        <CardHeader><CardTitle>Opportunity package</CardTitle></CardHeader>
        <CardContent>
          <pre className="whitespace-pre-wrap font-sans text-sm">{String(b.markdown)}</pre>
          {p && (
            <p className="mt-2 text-xs text-slate-500">
              From proposal{" "}
              <Link href={`/proposals/${String(p.id)}`} className="text-blue-700 hover:underline">
                {String(p.title)} (v{String(p.version)}, {String(p.status)})
              </Link>
              . Frozen inputs hash <code>{String(b.frozen_inputs_hash).slice(0, 16)}…</code>
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Pipeline</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm">
              Stage: <StageBadge stage={(b.pipeline_stage as string | null) ?? null} />
            </p>
            {b.next_action ? <p className="text-sm">Next: {String(b.next_action)} (manual — no reminders sent)</p> : null}
            {b.follow_up_date ? <p className="text-sm">Follow up: {String(b.follow_up_date)}</p> : null}
            <PipelineDialog briefRef={String(b.ref)} />
            <SimpleTable
              caption="Stage history"
              columns={["When", "Transition", "Note", "Actor"]}
              rows={ws.pipeline.map((e) => [
                <span key={`w${e.id}`}>{new Date(e.occurred_at).toLocaleString()}</span>,
                <span key={`t${e.id}`}>{e.from_stage ?? "∅"} → {e.to_stage}</span>,
                <span key={`n${e.id}`}>{e.note}</span>,
                <span key={`a${e.id}`}>{e.actor}</span>,
              ])}
              empty="No pipeline events. Stages record observed reality only."
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Outcomes (manual log)</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <OutcomeForm briefRef={String(b.ref)} />
            <SimpleTable
              caption="Recorded outcomes"
              columns={["Outcome", "Channel", "Note", "By"]}
              rows={ws.outcomes.map((o) => [
                <span key={`o${o.id}`}>{o.outcome}</span>,
                <span key={`c${o.id}`}>{o.channel ?? "—"}</span>,
                <span key={`n${o.id}`}>{o.note ?? "—"}</span>,
                <span key={`b${o.id}`}>{o.recorded_by}</span>,
              ])}
              empty="No outcomes recorded. Only a human records contact and results."
            />
          </CardContent>
        </Card>
      </div>

      <DraftWorkspace
        briefRef={String(b.ref)}
        drafts={ws.drafts}
      />
      <p className="text-xs text-slate-500">
        <CopyButton text={String(b.markdown)} label="Copy brief text" /> Drafts below are
        copy-only — the application cannot send them.
      </p>
    </div>
  );
}
