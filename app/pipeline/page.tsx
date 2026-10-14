import Link from "next/link";
import { getPool } from "@/lib/intake/db";
import { getOutcomes } from "@/lib/dashboard/queries";
import { learningReport, type SegmentRate } from "@/lib/outcomes/reports";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

const STAGE_ORDER = [
  "research",
  "qualified",
  "ready_for_outreach",
  "contacted",
  "responded",
  "discovery",
  "proposal_talk",
  "won",
  "lost",
  "disqualified",
  "on_hold",
];

export default async function PipelinePage() {
  await requireOperatorPage("/pipeline");
  let outcomes = null;
  let board: { pipeline_stage: string; ref: string; company: string; follow_up_date: string | null; next_action: string | null }[] = [];
  let due: { ref: string; company: string; follow_up_date: string; next_action: string | null }[] = [];
  let report: Awaited<ReturnType<typeof learningReport>> | null = null;
  try {
    const pool = getPool();
    outcomes = await getOutcomes();
    report = await learningReport(pool);
    const b = await pool.query(
      `select b.pipeline_stage, b.ref, c.name as company, b.follow_up_date, b.next_action
       from public.brief b join public.company c on c.id = b.company_id
       where b.pipeline_stage is not null order by b.follow_up_date nulls last`,
    );
    board = b.rows;
    const d = await pool.query(
      `select b.ref, c.name as company, b.follow_up_date, b.next_action
       from public.brief b join public.company c on c.id = b.company_id
       where b.follow_up_date is not null and b.follow_up_date <= (current_date + 7)
         and (b.pipeline_stage is null or b.pipeline_stage not in ('won','lost','disqualified'))
       order by b.follow_up_date`,
    );
    due = d.rows;
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "Sales Workspace" }, { label: "Pipeline" }]} title="Sales Pipeline" />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  const byOutcome = new Map<string, number>();
  for (const o of outcomes) byOutcome.set(o.outcome, (byOutcome.get(o.outcome) ?? 0) + 1);
  const byStage = new Map<string, typeof board>();
  for (const r of board) {
    const arr = byStage.get(r.pipeline_stage) ?? [];
    arr.push(r);
    byStage.set(r.pipeline_stage, arr);
  }

  const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);
  const rateCell = (rows: SegmentRate[]) =>
    rows.map((s) => [
      <span key={`k${s.key}`}>{s.key}</span>,
      <span key={`n${s.key}`}>{s.outcomes}</span>,
      <span key={`r${s.key}`}>
        {s.reply.lowData ? (
          <span className="text-slate-500">insufficient data ({s.reply.n}/{s.reply.denom})</span>
        ) : (
          `${pct(s.reply.n, s.reply.denom)} (${s.reply.n}/${s.reply.denom})`
        )}
      </span>,
      <span key={`w${s.key}`}>
        {s.win.lowData ? (
          <span className="text-slate-500">insufficient data ({s.win.n}/{s.win.denom})</span>
        ) : (
          `${pct(s.win.n, s.win.denom)} (${s.win.n}/${s.win.denom})`
        )}
      </span>,
    ]);
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Sales Workspace" }, { label: "Pipeline" }]}
        title="Sales Pipeline"
        description="Manually recorded stages and outcomes only. Stage labels describe observed reality — nothing here sends messages or notifies anyone."
      />
      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Follow-ups due (7 days)</CardTitle></CardHeader>
          <CardContent>
            <SimpleTable
              caption="Follow-ups due"
              columns={["Brief", "Agency", "Date", "Next action"]}
              rows={due.map((f) => [
                <Link key={`r${f.ref}`} href={`/briefs/${f.ref}`} className="text-blue-700 hover:underline">
                  {f.ref}
                </Link>,
                <span key={`c${f.ref}`}>{f.company}</span>,
                <span key={`d${f.ref}`}>{new Date(f.follow_up_date).toLocaleDateString()}</span>,
                <span key={`n${f.ref}`}>{f.next_action ?? "—"}</span>,
              ])}
              empty="Nothing due. Follow-ups are dates on briefs — the system sends no reminders."
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>By outcome</CardTitle></CardHeader>
          <CardContent>
            <ul className="flex flex-wrap gap-2 text-sm">
              {[...byOutcome.entries()].length === 0 && <li>No outcomes recorded.</li>}
              {[...byOutcome.entries()].map(([o, n]) => (
                <li key={o}>
                  <Badge variant={o === "won" ? "success" : o === "lost" ? "danger" : "info"}>
                    {o}: {n}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle>Stage board</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {STAGE_ORDER.filter((s) => (byStage.get(s) ?? []).length > 0).length === 0 && (
            <p className="text-sm text-slate-500">
              No briefs staged yet. Record stages from a brief page — stages never auto-advance.
            </p>
          )}
          {STAGE_ORDER.filter((s) => (byStage.get(s) ?? []).length > 0).map((s) => (
            <div key={s}>
              <p className="text-sm font-medium">
                <Badge variant={s === "won" ? "success" : s === "lost" || s === "disqualified" ? "danger" : "info"}>
                  {s}
                </Badge>{" "}
                ({byStage.get(s)!.length})
              </p>
              <ul className="list-disc pl-5 text-sm">
                {byStage.get(s)!.map((r) => (
                  <li key={r.ref}>
                    <Link href={`/briefs/${r.ref}`} className="text-blue-700 hover:underline">
                      {r.ref}
                    </Link>{" "}
                    — {r.company}
                    {r.follow_up_date ? ` (follow up ${new Date(r.follow_up_date).toLocaleDateString()})` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Outcome log ({outcomes.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Manual outcome log"
            columns={["Brief", "Agency", "Outcome", "Channel", "Sent (manual)", "Rejection", "By"]}
            rows={outcomes.map((o) => [
              <Link key={`b${o.id}`} href={`/briefs/${o.brief_ref}`} className="text-blue-700 hover:underline">
                {o.brief_ref}
              </Link>,
              o.company_name,
              o.outcome,
              o.channel ?? "—",
              o.sent_at_manual ?? "—",
              o.rejection_code ?? "—",
              o.recorded_by,
            ])}
            empty="No outcomes recorded yet."
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Learning reports (FR-025)</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <Alert tone="info">
            Descriptive counts only — nothing here tunes weights or thresholds (no automatic
            changes in MVP). Groups with fewer than 5 outcomes show “insufficient data”
            instead of a rate.
          </Alert>
          <p className="text-sm text-slate-600">
            {report!.overview.total === 0 ? (
              "No outcomes recorded yet — rates appear once the operator logs manual outcomes."
            ) : (
              <>
                {report!.overview.total} outcome{report!.overview.total === 1 ? "" : "s"} total · reply{" "}
                {report!.overview.reply.lowData
                  ? `insufficient data (${report!.overview.reply.n}/${report!.overview.reply.denom})`
                  : `${pct(report!.overview.reply.n, report!.overview.reply.denom)} (${report!.overview.reply.n}/${report!.overview.reply.denom})`}{" "}
                · win{" "}
                {report!.overview.win.lowData
                  ? `insufficient data (${report!.overview.win.n}/${report!.overview.win.denom})`
                  : `${pct(report!.overview.win.n, report!.overview.win.denom)} (${report!.overview.win.n}/${report!.overview.win.denom})`}
              </>
            )}
          </p>
          <SimpleTable
            caption="Reply and win rates by agency type"
            columns={["Agency type", "Outcomes", "Reply rate", "Win rate"]}
            rows={rateCell(report!.bySegment)}
            empty="No outcomes recorded yet."
          />
          <SimpleTable
            caption="Reply and win rates by channel"
            columns={["Channel", "Outcomes", "Reply rate", "Win rate"]}
            rows={rateCell(report!.byChannel)}
            empty="No outcomes recorded yet."
          />
          <SimpleTable
            caption="Reply and win rates by hypothesis category"
            columns={["Category", "Outcomes", "Reply rate", "Win rate"]}
            rows={rateCell(report!.byCategory)}
            empty="No outcomes recorded yet."
          />
          <SimpleTable
            caption="Reply and win rates by contributing source (a brief counts once per source that fed its hypothesis)"
            columns={["Source", "Outcomes", "Reply rate", "Win rate"]}
            rows={rateCell(report!.bySource)}
            empty="No outcomes recorded yet."
          />
          <SimpleTable
            caption="Top rejection reasons among lost outcomes"
            columns={["Code", "Lost", "Share of lost"]}
            rows={report!.rejections.rows.map((r) => [
              <span key={`c${r.code}`}>{r.code}</span>,
              <span key={`n${r.code}`}>{r.n}</span>,
              <span key={`s${r.code}`}>{r.share === null ? "—" : pct(r.n, report!.rejections.lost)}</span>,
            ])}
            empty={report!.rejections.lost === 0 ? "No lost outcomes recorded." : "No rejection codes recorded."}
          />
          <SimpleTable
            caption="Evidence health (ledger state, never a verdict)"
            columns={["Measure", "Count"]}
            rows={[
              ["Claims total", report!.health.claims],
              ["Expired claims", report!.health.expired],
              ["Disputed claims", report!.health.disputed],
              ["Withdrawn claims", report!.health.withdrawn],
              ["Superseded claims", report!.health.superseded],
              ["Assumed (unverified) claims", report!.health.assumed],
              ["Approved briefs", report!.health.approvedBriefs],
            ].map(([label, n], i) => [
              <span key={`l${i}`}>{label}</span>,
              <span key={`v${i}`}>{n}</span>,
            ])}
            empty="No claims recorded."
          />
        </CardContent>
      </Card>
    </div>
  );
}
