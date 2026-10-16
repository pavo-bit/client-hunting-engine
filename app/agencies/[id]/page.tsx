import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/intake/db";
import { getCompanyDetail } from "@/lib/resolve/detail";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { ResolveButton } from "@/components/resolve-button";
import { HypothesisGenerateButton } from "@/components/hypothesis-dialog";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export default async function AgencyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireOperatorPage("/agencies/[id]");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let detail = null;
  try {
    detail = await getCompanyDetail(getPool(), id);
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "Agency Intelligence" }, { label: "Directory", href: "/agencies" }, { label: "Detail" }]} title="Agency detail" />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  if (!detail) notFound();
  const c = detail.company;

  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Agency Intelligence" }, { label: "Directory", href: "/agencies" }, { label: c.name }]}
        title={c.name}
        description={`${c.agency_type} Â· ${c.country}${c.country_code ? ` (${c.country_code})` : ""}`}
        actions={
          <span className="inline-flex gap-2">
            <ResolveButton companyId={c.id} />
            {!c.merged_into && <HypothesisGenerateButton companyId={c.id} />}
          </span>
        }
      />
      {c.merged_into && (
        <Alert tone="warning">
          Merged into{" "}
          <Link href={`/agencies/${c.merged_into}`} className="underline">
            {c.merged_into_name ?? c.merged_into}
          </Link>
          . This record is preserved for history; its data now lives on the canonical record.
        </Alert>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Canonical identity</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>Status: <Badge variant={c.merged_into ? "warning" : c.discovery_status === "qualified" ? "success" : "default"}>{c.merged_into ? "merged" : c.discovery_status}</Badge></p>
            <p>Domain: {c.domain_norm ?? "â€”"}</p>
            <p>Registry: {c.registry_id ?? "â€”"}{c.registry_type ? ` (${c.registry_type})` : ""}</p>
            <p>Website: {c.website_url ?? "â€”"}</p>
            <p>Region: {c.region ?? "â€”"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Verified aliases ({detail.aliases.length})</CardTitle></CardHeader>
          <CardContent>
            {detail.aliases.length === 0 ? (
              <p className="text-sm text-slate-500">No aliases â€” none absorbed yet.</p>
            ) : (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {detail.aliases.map((a) => (
                  <li key={`${a.alias_type}:${a.alias_value}`}>
                    {a.alias_type}: {a.alias_value} ({a.verification}
                    {a.country_code ? `, ${a.country_code}` : ""})
                  </li>
                ))}
              </ul>
            )}
            {detail.absorbed.length > 0 && (
              <p className="mt-2 text-sm">
                Absorbed records:{" "}
                {detail.absorbed.map((a, i) => (
                  <span key={a.id}>
                    {i > 0 && ", "}
                    <Link href={`/agencies/${a.id}`} className="text-blue-700 hover:underline">
                      {a.name}
                    </Link>
                  </span>
                ))}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle>Duplicate candidates ({detail.candidates.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Candidates involving this record"
            columns={["Other record", "Rule", "Reason", "Conflict", "Status"]}
            rows={detail.candidates.map((k) => [
              <Link key="o" href={`/agencies/${k.other_id}`} className="text-blue-700 hover:underline">
                {k.other_name}
              </Link>,
              k.rule,
              k.detail,
              k.conflicting_registry ? (
                <Badge key="c" variant="danger">registry conflict</Badge>
              ) : (
                "â€”"
              ),
              k.status,
            ])}
            empty="No candidates. Run resolution to generate deterministic matches."
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Claims ({detail.claims.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Claims about this company, with the source and date behind each one"
            columns={["Statement", "Family", "Source", "Published", "Seen", "Status", "Freshness"]}
            rows={detail.claims.map((cl) => [
              <Link key={`t${cl.id}`} href={`/evidence/${cl.id}`} className="text-blue-700 hover:underline">
                {cl.claim_text.length > 120 ? `${cl.claim_text.slice(0, 120)}...` : cl.claim_text}
              </Link>,
              <span key={`p${cl.id}`} className="text-xs text-slate-600">{cl.predicate ?? "-"}</span>,
              <span key={`k${cl.id}`} className="font-mono text-xs">{cl.source_key ?? "no snapshot"}</span>,
              <span key={`pb${cl.id}`} className="text-xs">{cl.published_at ? new Date(cl.published_at).toISOString().slice(0, 10) : "-"}</span>,
              <span key={`ob${cl.id}`} className="text-xs">{cl.observed_at ? new Date(cl.observed_at).toISOString().slice(0, 10) : "-"}</span>,
              <span key={`s${cl.id}`}>{cl.claim_status}</span>,
              <span key={`f${cl.id}`}>{cl.stale ? "stale" : "fresh"}</span>,
            ])}
            empty="No claims recorded. Ingest observations to begin evidence."
          />
          <p className="mt-2 text-xs text-slate-500">
            Published is the date the source itself stated, left blank when it stated
            none. Seen is when the observation was captured. Claim status is never
            promoted automatically; verified and corroborated remain human-only.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Hypotheses ({detail.hypotheses.length})</CardTitle></CardHeader>        <CardContent>
          <SimpleTable
            caption="Hypotheses for this company"
            columns={["Hypothesis", "Rule", "Status"]}
            rows={detail.hypotheses.map((hh) => [
              <Link key={`h${hh.id}`} href={`/hypotheses/${hh.id}`} className="text-blue-700 hover:underline">
                {hh.title.length > 120 ? `${hh.title.slice(0, 120)}â€¦` : hh.title}
              </Link>,
              <span key={`r${hh.id}`}>{hh.rule_id ?? "â€”"}</span>,
              <span key={`s${hh.id}`}>{hh.status}</span>,
            ])}
            empty="No hypotheses. Generate runs deterministic rules over assessed evidence â€” silence means insufficient evidence."
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Proposals ({detail.proposals.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Proposals for this company"
            columns={["Proposal", "Status", "Facts vs assumptions"]}
            rows={detail.proposals.map((pp) => [
              <Link key={`p${pp.id}`} href={`/proposals/${pp.id}`} className="text-blue-700 hover:underline">
                {pp.title} (v{pp.version})
              </Link>,
              <span key={`s${pp.id}`}>{pp.status}</span>,
              <span key={`f${pp.id}`} className="text-xs text-slate-600">
                Indicative ranges with stated assumptions â€” never confirmed requirements.
              </span>,
            ])}
            empty="No proposals. Draft one from a validated hypothesis."
          />
        </CardContent>
      </Card>
      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Discovery provenance</CardTitle></CardHeader>
          <CardContent>
            <SimpleTable
              caption="Discovery records"
              columns={["Source", "Method", "Status", "Retrieved"]}
              rows={detail.discovery.map((d, i) => [
                <span key={`s${i}`}>{d.platform ?? "(direct operator entry)"}</span>,
                <span key={`m${i}`}>{d.collection_method}</span>,
                <span key={`t${i}`}>{d.retrieval_status}</span>,
                <span key={`r${i}`}>{new Date(d.retrieved_at).toLocaleString()}</span>,
              ])}
              empty="No discovery records."
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Identity history</CardTitle></CardHeader>
          <CardContent>
            <SimpleTable
              caption="Audit history"
              columns={["When", "Actor", "Transition", "Reason"]}
              rows={detail.audit.map((a, i) => [
                <span key={`w${i}`}>{new Date(a.created_at).toLocaleString()}</span>,
                <span key={`a${i}`}>{a.actor}</span>,
                <span key={`t${i}`}>{a.transition_from ?? "âˆ…"} â†’ {a.transition_to ?? "âˆ…"}</span>,
                <span key={`r${i}`}>{a.reason ?? "â€”"}</span>,
              ])}
              empty="No identity decisions recorded."
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
