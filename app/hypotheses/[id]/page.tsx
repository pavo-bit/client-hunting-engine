import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/intake/db";
import { getHypothesisDetail } from "@/lib/hypothesis/detail";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { HypothesisDecisionDialog } from "@/components/hypothesis-dialog";
import { ScoreEvaluateButton } from "@/components/score-dialog";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export default async function HypothesisDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireOperatorPage("/hypotheses/[id]");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let detail = null;
  try {
    detail = await getHypothesisDetail(getPool(), id);
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "Evidence & Diagnosis" }, { label: "Hypotheses", href: "/hypotheses" }, { label: "Detail" }]} title="Hypothesis" />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  if (!detail) notFound();
  const h = detail.hypothesis;

  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Evidence & Diagnosis" }, { label: "Hypotheses", href: "/hypotheses" }, { label: "Detail" }]}
        title={h.title}
        description={`A reasoned possibility for ${h.company_name} — not an established fact. Rule ${h.rule_id ?? "—"} v${h.rule_version ?? "—"}.`}
        actions={
          <span className="inline-flex gap-2">
            <HypothesisDecisionDialog hypothesisId={h.id} />
            <ScoreEvaluateButton hypothesisId={h.id} />
            {h.status === "validated" && (
              <Link
                href={`/proposals/new?hypothesis=${h.id}`}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
              >
                Draft proposal
              </Link>
            )}
          </span>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={h.status === "validated" ? "success" : h.status === "rejected" ? "danger" : "info"}>
          {h.status}
        </Badge>
        <Badge variant="default">{h.opportunity_category}</Badge>
        {detail.latestScore ? (
          <Badge variant="info">
            score_v1 {detail.latestScore.total} ({detail.latestScore.band})
            {detail.latestScore.partial ? " · partial inputs" : ""}
          </Badge>
        ) : (
          <Badge variant="default">unscored</Badge>
        )}
      </div>

      {h.rationale && (
        <Card>
          <CardHeader><CardTitle>Rationale</CardTitle></CardHeader>
          <CardContent><p className="text-sm">{h.rationale}</p></CardContent>
        </Card>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Supporting ({detail.supporting.length})</CardTitle></CardHeader>
          <CardContent>
            <SimpleTable
              caption="Supporting evidence"
              columns={["Claim", "Status"]}
              rows={detail.supporting.map((e) => [
                <Link key={`s${e.claim_id}`} href={`/evidence/${e.claim_id}`} className="text-blue-700 hover:underline">
                  {e.claim_text.length > 140 ? `${e.claim_text.slice(0, 140)}…` : e.claim_text}
                </Link>,
                <span key={`t${e.claim_id}`}>{e.status}</span>,
              ])}
              empty="No supporting evidence linked."
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Contradicting ({detail.contradicting.length})</CardTitle></CardHeader>
          <CardContent>
            <SimpleTable
              caption="Contradicting evidence"
              columns={["Claim", "Status"]}
              rows={detail.contradicting.map((e) => [
                <Link key={`s${e.claim_id}`} href={`/evidence/${e.claim_id}`} className="text-blue-700 hover:underline">
                  {e.claim_text.length > 140 ? `${e.claim_text.slice(0, 140)}…` : e.claim_text}
                </Link>,
                <span key={`t${e.claim_id}`}>{e.status}</span>,
              ])}
              empty="No contradictions recorded. Contradictions stay visible when present."
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Assumptions & alternatives</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p><strong>Assumptions:</strong> {h.assumptions ?? "—"}</p>
            <p><strong>Alternatives:</strong> {h.alternatives ?? "—"}</p>
            {detail.taxonomy && (
              <>
                <p><strong>Problem considered:</strong> {detail.taxonomy.problem}</p>
                <p><strong>Insufficient alone:</strong> {detail.taxonomy.insufficientAlone.join("; ")}</p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Validation & proposal</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p><strong>Missing information:</strong> {h.missing_info ?? "—"}</p>
            <p><strong>Questions to ask:</strong> {h.validation_questions ?? "—"}</p>
            <p><strong>Suggested intervention:</strong> {h.intervention ?? "—"}</p>
            {h.decided_by && (
              <p>
                <strong>Decided by {h.decided_by}</strong>
                {h.decided_at ? ` on ${new Date(h.decided_at).toLocaleString}` : ""}:{" "}
                {h.decision_rationale ?? ""}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Decision history ({detail.decisions.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Decision history"
            columns={["When", "Actor", "Transition", "Rationale"]}
            rows={detail.decisions.map((d, i) => [
              <span key={`w${i}`}>{new Date(d.created_at).toLocaleString()}</span>,
              <span key={`a${i}`}>{d.actor}</span>,
              <span key={`t${i}`}>{d.transition_from ?? "∅"} → {d.transition_to}</span>,
              <span key={`r${i}`}>{d.reason ?? "—"}</span>,
            ])}
            empty="No decisions recorded."
          />
          <p className="mt-2 text-xs text-slate-500">
            <Link href={`/agencies/${h.company_id}`} className="text-blue-700 hover:underline">
              Back to {h.company_name}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
