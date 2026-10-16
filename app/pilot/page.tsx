import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { getPool } from "@/lib/intake/db";
import { buildPilotReport, MIN_SAMPLE_FOR_PRECISION } from "@/lib/pilot/metrics";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

/**
 * /pilot â€” observed measurement, not projection.
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
          <CardTitle>Manual review precision</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm">
            Reviewed labels: <strong>{r.precision.reviewedLabels}</strong> Â· positive:{" "}
            <strong>{r.precision.positiveLabels}</strong>
          </p>
          <p className="text-sm">
            Precision:{" "}
            {r.precision.precision === null ? (
              <Badge variant="warning">not reported</Badge>
            ) : (
              <strong>{r.precision.precision}%</strong>
            )}
          </p>
          <p className="text-xs text-slate-600">{r.precision.basis}</p>
          <p className="text-xs text-slate-600">
            Minimum sample for a precision figure: {MIN_SAMPLE_FOR_PRECISION} reviewed labels.
          </p>
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
              <span key="l">{s.lastRunAt ?? "â€”"}</span>,
              <span key="s">{s.lastRunStatus ?? "â€”"}</span>,
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
            columns={["Measure", "Count"]}
            rows={[
              [<span key="a">Snapshots</span>, <span key="b">{r.evidenceFreshness.snapshots}</span>],
              [<span key="a">With verifiable source URL</span>, <span key="b">{r.evidenceFreshness.withVerifiableUrl}</span>],
              [<span key="a">With observation date</span>, <span key="b">{r.evidenceFreshness.withObservationDate}</span>],
              [<span key="a">With source publication date</span>, <span key="b">{r.evidenceFreshness.withPublicationDate ?? "schema too old"}</span>],
              [<span key="a">Days since newest observation</span>, <span key="b">{r.evidenceFreshness.medianAgeDays ?? "â€”"}</span>],
            ]}
            caption="Dates absent from the source are left empty, never approximated."
            empty="No observations captured yet."
          />
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
