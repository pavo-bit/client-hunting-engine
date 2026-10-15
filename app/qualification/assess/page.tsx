import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireOperatorPage } from "@/lib/auth/guard";
import { getPool } from "@/lib/intake/db";
import { AssessForm } from "@/components/qualification/assess-form";

export const dynamic = "force-dynamic";

/** GET /qualification/assess — assessment console. Explicit runs only; shows active versions to cite. */
export default async function AssessPage({
  searchParams,
}: {
  searchParams: Promise<{ opportunityId?: string }>;
}) {
  await requireOperatorPage("/qualification/assess");
  const sp = await searchParams;
  const opportunityId = (sp.opportunityId ?? "").trim();
  const pool = getPool();
  const active = await pool.query(
    "select kind, version from p2.reference_version where status = 'active' and kind in ('policy','service_catalog','rubric','capacity') order by kind",
  );
  const byKind = Object.fromEntries(
    (active.rows as { kind: string; version: string }[]).map((r) => [r.kind, r.version]),
  );
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Qualification" }, { label: "Assess" }]}
        title="Assessment console"
        description="Explicitly run (or re-run) one qualification assessment. Nothing here runs on its own; versions resolve explicitly and are recorded with the result."
      />
      <Card>
        <CardHeader><CardTitle>Run assessment</CardTitle></CardHeader>
        <CardContent>
          <AssessForm
            opportunityId={opportunityId}
            defaults={{
              policy: byKind.policy ?? null,
              catalog: byKind.service_catalog ?? null,
              rubric: byKind.rubric ?? null,
              capacity: byKind.capacity ?? null,
            }}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Active versions</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-slate-600">
            policy: {byKind.policy ?? "none — assessments refused until published"} · catalog:{" "}
            {byKind.service_catalog ?? "none"} · rubric: {byKind.rubric ?? "none"} · capacity:{" "}
            {byKind.capacity ?? "none (order unadjusted)"}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Publish versions from /qualification/policy. No active versions exist in production yet (O10 and
            related decisions open) — the console refuses rather than inventing defaults.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
