import Link from "next/link";
import { getOverview } from "@/lib/dashboard/queries";
import { PageHeader } from "@/components/page-header";
import { Alert, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

function Stat({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="text-2xl font-bold">{value}</p>
        <Link href={href} className="text-sm text-blue-700 hover:underline">
          {label}
        </Link>
      </CardContent>
    </Card>
  );
}

export default async function OverviewPage() {
  await requireOperatorPage("/overview");
  let data = null;
  let error: string | null = null;
  try {
    data = await getOverview();
  } catch {
    error = "Local database unreachable. Start it with `npm run db:up`, then `npm run db:migrate` + `npm run db:seed` (see implementation docs).";
  }

  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Command Center" }, { label: "Overview" }]}
        title="Overview"
        description="Live counts from the local database. Unavailable metrics are labeled, never invented."
      />
      {error || !data ? (
        <Alert tone="error">{error ?? "No data."}</Alert>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Agencies" value={data.companies} href="/agencies" />
            <Stat label="Evidence claims" value={data.claims} href="/evidence" />
            <Stat label="Hypotheses" value={data.hypotheses} href="/hypotheses" />
            <Stat label="Briefs" value={data.briefs} href="/review" />
            <Stat label="Recorded outcomes" value={data.outcomes} href="/pipeline" />
            <Stat label="Import batches" value={data.batches} href="/import" />
            <Stat label="Open failures" value={data.failuresOpen} href="/audit" />
            <Stat label="Migrations applied" value={data.migrationsApplied} href="/audit" />
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <Card>
              <CardHeader><CardTitle>Agencies by status</CardTitle></CardHeader>
              <CardContent>
                <ul className="space-y-1 text-sm">
                  {data.companiesByStatus.map((s) => (
                    <li key={s.status} className="flex justify-between">
                      <span>{s.status}</span><span className="font-medium">{s.n}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Claims by status</CardTitle></CardHeader>
              <CardContent>
                <ul className="space-y-1 text-sm">
                  {data.claimsByStatus.map((s) => (
                    <li key={s.status} className="flex justify-between">
                      <span>{s.status}</span><span className="font-medium">{s.n}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Briefs by status</CardTitle></CardHeader>
              <CardContent>
                <ul className="space-y-1 text-sm">
                  {data.briefsByStatus.length === 0 && <li>No briefs yet.</li>}
                  {data.briefsByStatus.map((s) => (
                    <li key={s.status} className="flex justify-between">
                      <span>{s.status}</span><span className="font-medium">{s.n}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>
          <Alert tone="info">
            Scoring, charts, and forecasts are unavailable: deterministic scoring
            runs per-hypothesis (see Ranking), and no analytical series exist.
            No metrics on this page are estimated.
          </Alert>
        </>
      )}
    </div>
  );
}
