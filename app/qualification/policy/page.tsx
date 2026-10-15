import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";
import { getPool } from "@/lib/intake/db";
import { PolicyForms } from "@/components/qualification/policy-forms";

export const dynamic = "force-dynamic";

/**
 * GET /qualification/policy — inspect versions, draft changes, lint/dry-run
 * and publish explicitly. Capacity management lives here too: profiles with
 * their ordering effect. Nothing on this page activates silently.
 */
export default async function PolicyPage() {
  await requireOperatorPage("/qualification/policy");
  const pool = getPool();
  let versions: Record<string, unknown>[] = [];
  let capacities: Record<string, unknown>[] = [];
  let error: string | null = null;
  try {
    const v = await pool.query(
      "select kind, version, status, recorded_by, recorded_at from p2.reference_version order by kind, recorded_at desc",
    );
    versions = v.rows as Record<string, unknown>[];
    const c = await pool.query(
      "select capacity_version, definition, recorded_by from p2.capacity_profile order by recorded_at desc",
    );
    capacities = c.rows as Record<string, unknown>[];
  } catch {
    error = "Local database unreachable.";
  }
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Qualification" }, { label: "Policy & catalog" }]}
        title="Policy, catalog, capacity"
        description="Versioned definitions with explicit lifecycles. Drafts never affect rankings; publication and retirement are audited operator acts."
      />
      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle>Versions</CardTitle></CardHeader>
            <CardContent>
              <SimpleTable
                caption="All reference versions with lifecycle status"
                columns={["Kind", "Version", "Status", "Recorded by", "At"]}
                rows={versions.map((v, i) => [
                  <span key={`k${i}`}>{v.kind as string}</span>,
                  <span key={`v${i}`} className="font-mono text-xs">{v.version as string}</span>,
                  <span key={`s${i}`}>
                    <Badge variant={(v.status as string) === "active" ? "success" : (v.status as string) === "retired" ? "danger" : "warning"}>
                      {v.status as string}
                    </Badge>
                  </span>,
                  <span key={`b${i}`} className="text-xs">{v.recorded_by as string}</span>,
                  <span key={`t${i}`} className="text-xs text-slate-600">
                    {new Date(v.recorded_at as string).toLocaleString()}
                  </span>,
                ])}
                empty="No versions registered. Draft the first one below — it stays draft until published."
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Draft, lint, publish, retire</CardTitle></CardHeader>
            <CardContent>
              <PolicyForms />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Capacity profiles (ordering only)</CardTitle></CardHeader>
            <CardContent>
              <SimpleTable
                caption="Capacity profiles and their pursuit-order effect"
                columns={["Version", "Max active", "Focus", "Recorded by"]}
                rows={capacities.map((c, i) => {
                  const d = c.definition as { maxActivePursuits: number | null; focusServices: string[]; focusPipelines: string[] };
                  return [
                    <span key={`v${i}`} className="font-mono text-xs">{c.capacity_version as string}</span>,
                    <span key={`m${i}`}>{d.maxActivePursuits ?? "unbounded"}</span>,
                    <span key={`f${i}`} className="text-xs">
                      services: {(d.focusServices ?? []).join(", ") || "—"} · pipelines: {(d.focusPipelines ?? []).join(", ") || "—"}
                    </span>,
                    <span key={`b${i}`} className="text-xs">{c.recorded_by as string}</span>,
                  ];
                })}
                empty="No capacity profiles. Without one, pursuit order equals composite order exactly."
              />
              <p className="mt-2 text-xs text-slate-500">
                Capacity influences pursuit order only — never intrinsic fit. A profile with no active version
                changes nothing.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
