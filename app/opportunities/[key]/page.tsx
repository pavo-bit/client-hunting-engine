import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/intake/db";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { eligibilityHistory } from "@/lib/discovery/eligibility";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

/** Escape untrusted source content: React escapes by default; URLs are
 *  validated to http(s) before becoming links (never javascript:). */
function safeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().slice(0, 2000);
  if (/^https?:\/\//i.test(v) && !/[\r\n]/.test(v)) return v;
  return null;
}

/**
 * GET /opportunities/[key] — one opportunity: identity + review status,
 * pipeline/lifecycle, source references with timestamps, evidence with
 * provenance/freshness (supporting AND contradicting), solution-check state,
 * eligibility rules + explanations, policy versions, lifecycle history with
 * attribution. Observed facts vs inferences vs assumptions stay labeled via
 * claim statuses; nothing here upgrades them.
 */
export default async function OpportunityDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ pipeline?: string }>;
}) {
  await requireOperatorPage("/opportunities/[key]");
  const { key } = await params;
  const sp = await searchParams;
  const pipeline = (sp.pipeline ?? "agency_partner").trim();
  if (pipeline !== "agency_partner" && pipeline !== "direct_client") notFound();

  let data: {
    opportunity: Record<string, unknown>;
    evidence: Record<string, unknown>[];
    history: { version: number; decision: string; policyVersion: string; gateReasons: unknown }[];
    lifecycle: Record<string, unknown>[];
  } | null = null;
  let missing = false;
  try {
    const pool = getPool();
    const o = await pool.query(
      `select o.id, o.pipeline, o.opportunity_key, o.status, o.solution_status,
              o.first_seen_at, o.created_at, o.updated_at,
              c.id as company_id, c.name as company_name, c.domain_norm,
              c.registry_id, c.merged_into
       from public.opportunity o
       left join public.company c on c.id = o.company_id
       where o.pipeline = $1 and o.opportunity_key = $2`,
      [pipeline, decodeURIComponent(key)],
    );
    if (o.rows.length === 0) {
      missing = true;
    } else {
      const row = o.rows[0] as Record<string, unknown>;
      const evidence =
        row.company_id == null
          ? []
          : (
              await pool.query(
                `select cl.id, left(cl.claim_text, 300) as text, cl.claim_status,
                        cl.predicate, s.url, s.source_key, cl.observed_at, cl.expires_at,
                        (select count(*)::int from public.claim_evidence e
                         where e.claim_id = cl.id and e.polarity = 'contradicts') as contradictions
                 from public.claim cl
                 join public.snapshot s on s.id = cl.snapshot_id
                 where cl.company_id = $1 order by cl.created_at desc limit 100`,
                [row.company_id],
              )
            ).rows as Record<string, unknown>[];
      const history = await eligibilityHistory(pool, row.id as string);
      const lifecycle = (
        await pool.query(
          `select transition_from, transition_to, actor, reason, created_at
           from public.audit_log where entity_type = 'opportunity' and entity_id = $1
           order by created_at`,
          [row.id],
        )
      ).rows as Record<string, unknown>[];
      data = {
        opportunity: row,
        evidence,
        history: history.map((h) => ({
          version: h.version,
          decision: h.decision,
          policyVersion: h.policyVersion,
          gateReasons: h.gateReasons,
        })),
        lifecycle,
      };
    }
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "Agency Intelligence" }, { label: "Opportunities", href: "/opportunities" }, { label: key }]} title="Opportunity" />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  if (missing || !data) notFound();
  const op = data.opportunity;

  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Agency Intelligence" }, { label: "Opportunities", href: "/opportunities" }, { label: String(op.opportunity_key).slice(0, 60) }]}
        title={String(op.opportunity_key)}
        description="Discovered opportunity with evidence, eligibility, and lifecycle. Statuses describe review state — never purchasing intent."
      />
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="default">{op.pipeline as string}</Badge>
        <Badge variant={op.status === "eligible" || op.status === "promoted" ? "success" : op.status === "ineligible" ? "danger" : "default"}>
          {op.status as string}
        </Badge>
        <Badge variant="default">solution: {op.solution_status as string}</Badge>
        {op.company_id != null && (
          <Link href={`/agencies/${op.company_id as string}`} className="text-sm text-blue-700 hover:underline">
            {op.merged_into != null ? "Canonical agency (merged)" : "Agency"}: {(op.company_name as string) ?? "—"}
          </Link>
        )}
      </div>

      <Card>
        <CardHeader><CardTitle>Evidence ({data.evidence.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Linked evidence with provenance"
            columns={["Claim", "Status", "Source", "Observed", "Contradictions"]}
            rows={data.evidence.map((e) => {
              const url = safeUrl(e.url);
              return [
                <span key={`t${e.id as string}`} className="block max-w-xl whitespace-pre-wrap text-xs">
                  [{e.predicate as string}] {e.text as string}
                </span>,
                <span key={`s${e.id as string}`}>
                  <Badge variant={e.claim_status === "disputed" ? "warning" : "default"}>{e.claim_status as string}</Badge>
                </span>,
                url ? (
                  <a key={`u${e.id as string}`} href={url} target="_blank" rel="noreferrer" className="text-xs text-blue-700 hover:underline">
                    {e.source_key as string}
                  </a>
                ) : (
                  <span key={`u${e.id as string}`} className="text-xs text-slate-500">{e.source_key as string} (no linkable URL)</span>
                ),
                <span key={`o${e.id as string}`} className="text-xs text-slate-600">
                  {e.observed_at != null ? new Date(e.observed_at as string).toLocaleDateString() : "—"}
                  {e.expires_at != null ? ` · expires ${new Date(e.expires_at as string).toLocaleDateString()}` : ""}
                </span>,
                <span key={`c${e.id as string}`}>{e.contradictions as number}</span>,
              ];
            })}
            empty="No evidence linked yet."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Eligibility history ({data.history.length})</CardTitle></CardHeader>
        <CardContent>
          {data.history.length === 0 ? (
            <p className="text-sm text-slate-500">
              No eligibility decision recorded. Evaluations require an explicit policy version — none is approved yet (O10).
            </p>
          ) : (
            <SimpleTable
              caption="Versioned eligibility decisions"
              columns={["Version", "Decision", "Policy", "Gate reasons"]}
              rows={data.history.map((h) => [
                <span key={`v${h.version}`}>v{h.version}</span>,
                <Badge key={`d${h.version}`} variant={h.decision === "eligible" ? "success" : h.decision === "ineligible" ? "danger" : "warning"}>
                  {h.decision}
                </Badge>,
                <span key={`p${h.version}`} className="text-xs">{h.policyVersion}</span>,
                <span key={`g${h.version}`} className="block max-w-xl whitespace-pre-wrap text-xs text-slate-600">
                  {JSON.stringify(h.gateReasons)}
                </span>,
              ])}
              empty="No decisions."
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Lifecycle ({data.lifecycle.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Audited lifecycle transitions"
            columns={["From", "To", "Actor", "Reason", "At"]}
            rows={data.lifecycle.map((l, i) => [
              <span key={`f${i}`}>{(l.transition_from as string) ?? "—"}</span>,
              <span key={`t${i}`}>{l.transition_to as string}</span>,
              <span key={`a${i}`}>{l.actor as string}</span>,
              <span key={`r${i}`} className="block max-w-xl whitespace-pre-wrap text-xs text-slate-600">{l.reason as string}</span>,
              <span key={`d${i}`} className="text-xs text-slate-600">{new Date(l.created_at as string).toLocaleString()}</span>,
            ])}
            empty="No transitions recorded."
          />
        </CardContent>
      </Card>
    </div>
  );
}
