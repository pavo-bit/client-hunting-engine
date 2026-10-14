import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/intake/db";
import { getClaimDetail } from "@/lib/evidence/detail";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { AssessDialog } from "@/components/assess-dialog";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

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

export default async function ClaimDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireOperatorPage("/evidence/[id]");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let detail = null;
  try {
    detail = await getClaimDetail(getPool(), id);
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "Evidence & Diagnosis" }, { label: "Evidence", href: "/evidence" }, { label: "Claim" }]} title="Claim" />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  if (!detail) notFound();
  const c = detail.claim;

  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Evidence & Diagnosis" }, { label: "Evidence", href: "/evidence" }, { label: "Claim" }]}
        title="Claim assessment"
        description={`${c.company_name} — a reviewer can tell verified information from assumptions here without touching the database.`}
        actions={<AssessDialog claimId={c.id} current={c.claim_status} />}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={tone[c.claim_status] ?? "default"}>{c.claim_status}</Badge>
        {c.stale && <Badge variant="danger">stale (expired)</Badge>}
        {c.needs_review && <Badge variant="warning">needs review</Badge>}
        {c.predicate && <Badge variant="info">{c.predicate}</Badge>}
      </div>

      <Card>
        <CardHeader><CardTitle>Statement</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>{c.claim_text}</p>
          <p className="text-slate-600">
            Reliability {c.source_reliability} (source) · credibility {c.info_credibility}/5 (this claim) — recorded separately.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Provenance</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm">
          {detail.origin ? (
            <>
              <p>Source: {detail.origin.source_key}</p>
              <p className="break-all">URL: {detail.origin.url}</p>
              <p>Captured: {new Date(detail.origin.fetched_at).toLocaleString()}</p>
              {c.observed_at && (
                <p>Event observed: {new Date(c.observed_at).toLocaleString()}</p>
              )}
              <p>SHA-256: <code>{detail.origin.sha256.slice(0, 16)}…</code></p>
              <p>
                Retention: {detail.origin.retention_class}
                {detail.origin.suppressed ? " (suppressed — takedown)" : ""}
              </p>
              {detail.origin.excerpt && (
                <p>
                  Excerpt (quoted source text, untrusted):{" "}
                  <q className="text-slate-600">{detail.origin.excerpt}</q>
                </p>
              )}
            </>
          ) : (
            <p>Provenance unavailable — recorded as such, not invented.</p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Supporting ({detail.supporting.length})</CardTitle></CardHeader>
          <CardContent>
            <SimpleTable
              caption="Supporting evidence"
              columns={["Origin", "Note"]}
              rows={detail.supporting.map((e) => [
                e.origin_key ?? "—",
                e.note ?? "—",
              ])}
              empty="No supporting evidence linked. Corroboration needs two independent origins."
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Contradicting ({detail.contradicting.length})</CardTitle></CardHeader>
          <CardContent>
            <SimpleTable
              caption="Contradicting evidence"
              columns={["Origin", "Note"]}
              rows={detail.contradicting.map((e) => [
                e.origin_key ?? "—",
                e.note ?? "—",
              ])}
              empty="No contradictions recorded. Contradictions are preserved when present — never deleted."
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Assessment rationale</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm">
          {detail.recommendation.reasons.map((r) => (
            <p key={r}>• {r}</p>
          ))}
          {detail.recommendation.eligibleVerified && (
            <p className="font-medium">
              Eligible for verified — but only through an authorized human decision above.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Assessment history ({detail.assessments.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Assessment history"
            columns={["When", "Actor", "Transition", "Rationale"]}
            rows={detail.assessments.map((a, i) => [
              <span key={`w${i}`}>{new Date(a.created_at).toLocaleString()}</span>,
              <span key={`a${i}`}>{a.actor}{a.automatic ? " (automatic)" : ""}</span>,
              <span key={`t${i}`}>{a.from_status ?? "∅"} → {a.to_status}</span>,
              <span key={`r${i}`}>{a.rationale}</span>,
            ])}
            empty="No assessments recorded."
          />
          <p className="mt-2 text-xs text-slate-500">
            <Link href={`/agencies/${c.company_id}`} className="text-blue-700 hover:underline">
              Back to {c.company_name}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
