import Link from "next/link";
import { getPool } from "@/lib/intake/db";
import { getDiscovery } from "@/lib/dashboard/queries";
import { GleifAdapter } from "@/lib/discovery/adapters/gleif";
import { refreshSummary } from "@/lib/discovery/refresh";
import { sourcePermissions } from "@/lib/discovery/sources";
import { listIdentityConflicts } from "@/lib/resolve/conflicts";
import type { IdentityConflict } from "@/lib/resolve/conflicts";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { DiscoveryRunForm } from "@/components/discovery-run-form";
import { RefreshPlanForm } from "@/components/refresh-plan-form";
import { ReapRunsForm } from "@/components/reap-runs-form";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

interface RunRow {
  id: string;
  adapter_id: string;
  status: string;
  query_text: string;
  started_at: string;
  found: number;
  created_new: number;
  duplicates: number;
  skipped: number;
  conflicts: number;
  failed_items: number;
  error: string | null;
}

interface RunItem {
  source_record_id: string;
  status: string;
  company_id: string | null;
  candidate_id: string | null;
  warnings: string[];
  note: string | null;
}

export default async function DiscoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string; refresh?: string }>;
}) {
  await requireOperatorPage("/discovery");
  const { run: runId, refresh: refreshId } = await searchParams;
  let records = null;
  let runs: RunRow[] = [];
  let detail: { run: RunRow; items: RunItem[] } | null = null;
  let conflicts: IdentityConflict[] = [];
  let refresh: Awaited<ReturnType<typeof refreshSummary>> | null = null;
  let permissions: { key: string; category: string; enabled: boolean }[] = [];
  let activeRuns: { id: string; adapter_id: string; query_text: string; started_at: string }[] = [];
  let dbError: string | null = null;
  try {
    const pool = getPool();
    [records] = [await getDiscovery()];
    permissions = await sourcePermissions(pool);
    activeRuns = (
      await pool.query(
        `select id, adapter_id, query_text, started_at from public.discovery_run
         where status = 'running' order by started_at asc`,
      )
    ).rows as { id: string; adapter_id: string; query_text: string; started_at: string }[];
    runs = (
      await pool.query(
        `select id, adapter_id, status, query_text, started_at, found,
                created_new, duplicates, skipped, conflicts, failed_items, error
         from public.discovery_run order by started_at desc limit 50`,
      )
    ).rows as RunRow[];
    if (runId) {
      const r = await pool.query(
        `select id, adapter_id, status, query_text, started_at, found,
                created_new, duplicates, skipped, conflicts, failed_items, error
         from public.discovery_run where id = $1`,
        [runId],
      );
      if (r.rows.length > 0) {
        const items = (
          await pool.query(
            `select source_record_id, status, company_id, candidate_id, warnings, note
             from public.discovery_run_item where run_id = $1 order by created_at limit 200`,
            [runId],
          )
        ).rows as RunItem[];
        detail = { run: r.rows[0] as RunRow, items };
        conflicts = await listIdentityConflicts(pool, { runId, limit: 200 });
      }
    }
    if (refreshId) {
      // Same live projection as GET /api/discovery/refreshes/[id] — one
      // implementation, no duplicated logic.
      try {
        refresh = await refreshSummary(getPool(), refreshId);
      } catch {
        refresh = null;
      }
    }
  } catch {
    dbError = "Local database unreachable.";
  }

  const manifest = new GleifAdapter().manifest();

  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Agency Intelligence" }, { label: "Discovery" }]}
        title="Discovery"
        description="One verified live source (GLEIF LEI Index) plus manual/import intake. Runs are bounded, synchronous, and idempotent."
      />
      {dbError && <Alert tone="error">{dbError}</Alert>}
      <Card>
        <CardHeader>
          <CardTitle>
            {manifest.name} <Badge variant="success">live</Badge>
          </CardTitle>
          <p className="text-sm text-slate-600">
            {manifest.accessRequirements} · max {manifest.maxPageSize}/page ·
            version {manifest.version}
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-slate-600">
            Limits: {manifest.limitations.join("; ")}.
          </p>
          <DiscoveryRunForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Source permissions</CardTitle>
          <p className="text-sm text-slate-600">
            The source registry is the permission gate: a disabled source cannot run
            (runs are refused before any write). Disabled rows are listed here so
            permission problems are visible, not silent.
          </p>
        </CardHeader>
        <CardContent>
          <SimpleTable
            caption="Source registry permissions"
            columns={["Source", "Category", "State"]}
            rows={permissions.map((p) => [
              <span key={`k${p.key}`}>{p.key}</span>,
              <span key={`c${p.key}`}>{p.category}</span>,
              <span key={`e${p.key}`}>
                <Badge variant={p.enabled ? "success" : "default"}>
                  {p.enabled ? "enabled" : "disabled"}
                </Badge>
              </span>,
            ])}
            empty="No source rows."
          />
        </CardContent>
      </Card>

      {activeRuns.length > 0 && (
        <Alert tone="warning">
          {activeRuns.length} run{activeRuns.length === 1 ? " is" : "s are"} still marked
          running (oldest {new Date(activeRuns[0].started_at).toLocaleString()}). If a process
          died mid-run, close it out below — nothing resumes automatically.
        </Alert>
      )}

      <Card>
        <CardHeader><CardTitle>Crashed/stalled run recovery</CardTitle></CardHeader>
        <CardContent>
          <ReapRunsForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Manual refresh (planned tasks)</CardTitle></CardHeader>
        <CardContent>
          <RefreshPlanForm />
        </CardContent>
      </Card>

      {refresh && (
        <Card>
          <CardHeader>
            <CardTitle>
              Refresh {refresh.endState} (run {refresh.runStatus})
            </CardTitle>
            <p className="text-sm text-slate-600">
              tasks total={refresh.coverage.total} done={refresh.coverage.done}{" "}
              failed={refresh.coverage.failed} skipped={refresh.coverage.skipped_low_yield} ·{" "}
              new eligible={refresh.measures.new_eligible} promoted={refresh.measures.promoted}{" "}
              new evidence={refresh.measures.new_evidence} duplicates={refresh.measures.duplicates}{" "}
              excluded={refresh.measures.excluded} stale={refresh.measures.stale}{" "}
              {/* F7: show the split, not just the total. An operator reading
                  `unresolved=N` cannot tell whether N means businesses awaiting
                  a decision or plan work never finished; both are shown. */}
              unresolved={refresh.measures.unresolved} (opportunities=
              {refresh.measures.unresolved_opportunities}, tasks=
              {refresh.measures.unresolved_tasks})
            </p>
          </CardHeader>
          <CardContent>
            {refresh.shortfall.length > 0 ? (
              <SimpleTable
                caption="Pipeline shortfall (caller-stated targets; never transferred)"
                columns={["Pipeline", "Target", "Actual", "Shortfall", "Reason"]}
                rows={refresh.shortfall.map((s, i) => [
                  <span key={`p${i}`}>{s.pipeline}</span>,
                  <span key={`t${i}`}>{s.target}</span>,
                  <span key={`a${i}`}>{s.actual}</span>,
                  <span key={`s${i}`}>{s.shortfall}</span>,
                  <span key={`r${i}`} className="text-xs text-slate-600">{s.reason}</span>,
                ])}
                empty="No shortfall rows."
              />
            ) : (
              <p className="text-sm text-slate-500">
                Task yields are frozen history; opportunity states reflect now
                (re-evaluation moves rows between buckets by design).
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {detail && (
        <Card>
          <CardHeader>
            <CardTitle>
              Run {detail.run.status} — “{detail.run.query_text}”
            </CardTitle>
            <p className="text-sm text-slate-600">
              found={detail.run.found} new={detail.run.created_new} duplicates=
              {detail.run.duplicates} skipped={detail.run.skipped} conflicts=
              {detail.run.conflicts} failed={detail.run.failed_items}
              {detail.run.error ? ` — ${detail.run.error}` : ""}
            </p>
          </CardHeader>
          <CardContent>
            <SimpleTable
              caption="Run items"
              columns={["Source record", "Outcome", "Company", "Review", "Warnings / note"]}
              rows={detail.items.map((it, i) => [
                <code key={`s${i}`}>{it.source_record_id}</code>,
                <span key={`t${i}`}>{it.status}</span>,
                it.company_id ? (
                  <Link key={`c${i}`} href={`/agencies/${it.company_id}`} className="text-blue-700 hover:underline">
                    open
                  </Link>
                ) : (
                  "—"
                ),
                it.candidate_id ? (
                  <Link key={`k${i}`} href="/resolve" className="text-blue-700 hover:underline">
                    review queue
                  </Link>
                ) : (
                  "—"
                ),
                <span key={`w${i}`} className="text-xs text-slate-600">
                  {[...it.warnings, it.note].filter(Boolean).join("; ") || "—"}
                </span>,
              ])}
              empty="No items recorded."
            />
          </CardContent>
        </Card>
      )}

      {conflicts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Identity conflicts ({conflicts.length})</CardTitle>
            <p className="text-sm text-slate-600">
              What the source claimed, captured for human review. These are NOT
              merges and NOT companies: the conflicting record was refused from
              becoming a company (canonical identity rules), so nothing about
              the existing agency was changed. Decide in /resolve.
            </p>
          </CardHeader>
          <CardContent>
            <SimpleTable
              caption="Identity conflicts awaiting human review"
              columns={["Observed name", "Observed registry / domain", "Rule", "Existing agency", "Status"]}
              rows={conflicts.map((c) => [
                <span key={`n${c.id}`}>{c.observedName ?? "—"}</span>,
                <span key={`r${c.id}`} className="text-xs text-slate-600">
                  {c.observedRegistryId ?? "—"}
                  {c.observedDomain ? ` · ${c.observedDomain}` : ""}
                  {c.observedCountryCode ? ` (${c.observedCountryCode})` : ""}
                </span>,
                <span key={`u${c.id}`}>{c.rule}</span>,
                <Link key={`c${c.id}`} href={`/agencies/${c.companyId}`} className="text-blue-700 hover:underline">
                  open
                </Link>,
                <span key={`s${c.id}`}>
                  <Badge variant={c.status === "pending" ? "warning" : "default"}>{c.status}</Badge>
                </span>,
              ])}
              empty="No conflicts recorded for this run."
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Run history ({runs.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Discovery runs"
            columns={["Started", "Adapter", "Query", "Status", "Found / new / dup / skip / confl / fail"]}
            rows={runs.map((r) => [
              <Link key={`a${r.id}`} href={`/discovery?run=${r.id}`} className="text-blue-700 hover:underline">
                {new Date(r.started_at).toLocaleString()}
              </Link>,
              <span key={`b${r.id}`}>{r.adapter_id}</span>,
              <span key={`c${r.id}`}>{r.query_text}</span>,
              <Badge
                key={`d${r.id}`}
                variant={r.status === "ok" ? "success" : r.status === "failed" ? "danger" : "warning"}
              >
                {r.status}
              </Badge>,
              <span key={`e${r.id}`}>
                {r.found}/{r.created_new}/{r.duplicates}/{r.skipped}/{r.conflicts}/{r.failed_items}
              </span>,
            ])}
            empty="No runs yet. Start a bounded run above."
          />
        </CardContent>
      </Card>

      {records && (
        <Card>
          <CardHeader><CardTitle>Discovery records ({records.length})</CardTitle></CardHeader>
          <CardContent>
            <SimpleTable
              caption="Discovery records"
              columns={["Agency", "Source", "Method", "Status", "Retrieved", "Note"]}
              rows={records.map((d) => [
                d.company_name,
                d.source_platform ?? "(direct operator entry)",
                d.collection_method,
                <Badge key={`s${d.id}`} variant={d.retrieval_status === "ok" ? "success" : "danger"}>
                  {d.retrieval_status}
                </Badge>,
                new Date(d.retrieved_at).toLocaleString(),
                d.note ?? "—",
              ])}
              empty="No discovery records yet."
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
