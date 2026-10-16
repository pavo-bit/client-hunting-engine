import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { getPool } from "@/lib/intake/db";
import { buildPilotReport, MIN_SAMPLE_FOR_PRECISION } from "@/lib/pilot/metrics";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

/**
 * /pilot — observed measurement, not projection.
 *
 * Every figure is a database count with its denominator shown. When the sample
 * is too small the page says so explicitly and refuses to print a precision
 * figure; that refusal is the point, not a missing feature.
 */
export default async function PilotPage() {
  await requireOperatorPage("/pilot");
  let report = null;
  try {
    report = await buildPilotReport(getPool());
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "Assurance" }, { label: "Pilot" }]} title="Pilot report" />
        <Alert tone="error">
          Local database unreachable. Start Docker PostgreSQL (docker compose up) and reload.
        </Alert>
      </div>
    );
  }

  const r = report!;
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Assurance" }, { label: "Pilot" }]}
        title="Pilot report"
        description={`Observed counts over the current local database, generated ${r.generatedAt}. Nothing here is estimated, projected or extrapolated.`}
      />

      {r.inconclusive && (
        <Alert tone="warning">
          <strong>Pilot is INCONCLUSIVE.</strong>
          <ul className="mt-1 list-disc pl-5">
            {r.reasons.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </Alert>
      )}

      {r.blockers.map((b) => (
        <Alert key={b.code} tone="error">
          <strong>{b.code}</strong>: {b.message}
        </Alert>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>Population</CardTitle>
        </CardHeader>
        <CardContent>
          <SimpleTable
            columns={["Population", "Count"]}
            rows={r.population.map((p) => [<span key="l">{p.label}</span>, <span key="v">{p.count}</span>])}
            caption="Every metric below is a count within these populations."
            empty="No records yet."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Quality metrics (observed)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {r.metrics.map((m) => (
            <div key={m.key} className="border-b border-slate-100 pb-3 last:border-0">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{m.label}</span>
                <span className="text-lg font-semibold tabular-nums">
                  {m.value === null ? "—" : m.value}
                </span>
                {m.share && (
                  <span className="text-sm text-slate-600">
                    ({m.share} of {m.denominator})
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-600">{m.definition}</p>
              <p className="text-xs text-amber-700">{m.caveat}</p>
            </div>
          ))}
          {r.metrics.length === 0 && <p className="text-sm text-slate-500">No metrics available.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Manual review precision (human correctness labels)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm">
            Reviewed records: <strong>{r.precision.reviewedRecords}</strong> · pilot standard: {r.precision.standard.requiredRecords} records across {r.precision.standard.requiredRuns} runs · {r.precision.standard.met ? "met" : "not met"}
          </p>
          <p className="text-sm">
            Precision:{" "}
            {r.precision.value === null ? (
              <Badge variant="warning">not reported</Badge>
            ) : (
              <strong>{r.precision.value}%</strong>
            )}
            {r.precision.ci95 && (
              <span className="ml-2 text-slate-600">
                95% Wilson CI [{Math.round(r.precision.ci95.low * 100)}%, {Math.round(r.precision.ci95.high * 100)}%]
              </span>
            )}
          </p>
          <p className="text-xs text-slate-600">{r.precision.basis}</p>
          <p className="text-xs text-slate-600">
            Precision comes from <code>public.source_record_review</code>: a human judging whether a source record was factually correct. It is never inferred from a score, a policy verdict, or an accepted qualification case.
          </p>
          {r.perSourcePrecision.length > 0 && (
            <SimpleTable
              columns={["Source", "Reviewed", "Correct", "Incorrect", "Unusable", "Runs", "Precision", "95% CI", "Meets standard"]}
              rows={r.perSourcePrecision.map((s) => [
                <span key="k" className="font-mono text-xs">{s.sourceKey}</span>,
                <span key="r">{s.reviewedRecords}</span>,
                <span key="c">{s.labelledCorrect}</span>,
                <span key="i">{s.labelledIncorrect}</span>,
                <span key="u">{s.labelledUnusable}</span>,
                <span key="n">{s.distinctRuns}</span>,
                <span key="p">{s.precision === null ? "-" : `${s.precision}%`}</span>,
                <span key="ci">{s.ci95 ? `[${Math.round(s.ci95.low * 100)}%, ${Math.round(s.ci95.high * 100)}%]` : "-"}</span>,
                <span key="m">{s.meetsPilotStandard ? "yes" : "no"}</span>,
              ])}
              caption="Reaching the count alone is NOT an acceptance criterion; the agreed confidence bound must also be satisfied."
              empty="No review labels recorded."
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Source health</CardTitle>
        </CardHeader>
        <CardContent>
          <SimpleTable
            columns={["Source", "Platform", "Enabled", "Records", "Companies", "Last run", "Status"]}
            rows={r.sourceHealth.map((s) => [
              <span key="k" className="font-mono text-xs">{s.key}</span>,
              <span key="p">{s.platform}</span>,
              s.enabled ? <Badge key="e" variant="success">enabled</Badge> : <Badge key="e" variant="default">disabled</Badge>,
              <span key="r">{s.records}</span>,
              <span key="c">{s.companies}</span>,
              <span key="l">{s.lastRunAt ?? "—"}</span>,
              <span key="s">{s.lastRunStatus ?? "—"}</span>,
            ])}
            caption="A disabled source is refused before a run row exists, so 'no run' is not evidence of failure."
            empty="No sources registered."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Evidence freshness</CardTitle>
        </CardHeader>
        <CardContent>
          <SimpleTable
            columns={["Measure", "Population", "Value"]}
            rows={[
              [
                <span key="a">Median age of evidence (days)</span>,
                <span key="b">{r.freshness.observationSample} snapshot(s) with a valid observed_at</span>,
                <span key="c">{r.freshness.medianObservationAgeDays ?? "unavailable"}</span>,
              ],
              [
                <span key="a">Median ingestion age (days)</span>,
                <span key="b">{r.freshness.ingestionSample} snapshot(s) captured</span>,
                <span key="c">{r.freshness.medianIngestionAgeDays ?? "unavailable"}</span>,
              ],
              [
                <span key="a">Median publication age (days)</span>,
                <span key="b">{r.freshness.publicationSample} claim(s) with a source publication date</span>,
                <span key="c">{r.freshness.medianPublicationAgeDays ?? "unavailable"}</span>,
              ],
            ]}
            caption="Each row names its population and its date field. Missing or invalid dates are excluded; an empty population reports unavailable, never 0 days."
            empty="No observations captured yet."
          />
          <p className="mt-2 text-xs text-slate-500">
            Observation age uses snapshot.observed_at (when the event was seen). Ingestion age uses snapshot.fetched_at (when we captured it). Publication age uses claim.published_at (what the source itself stated). They are never substituted for one another, and evidence freshness is unrelated to whether a company record exists.
          </p>
        </CardContent>
      </Card>


      <Alert tone="info">
        This platform has no scheduler and no autonomous worker. Every run, observation
        and decision in these figures was produced by an operator action. Do not read
        "no runs" as "running".
      </Alert>
    </div>
  );
}
