import Link from "next/link";
import { getPool } from "@/lib/intake/db";
import { getDiscovery } from "@/lib/dashboard/queries";
import { GleifAdapter } from "@/lib/discovery/adapters/gleif";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { DiscoveryRunForm } from "@/components/discovery-run-form";
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
  searchParams: Promise<{ run?: string }>;
}) {
  await requireOperatorPage("/discovery");
  const { run: runId } = await searchParams;
  let records = null;
  let runs: RunRow[] = [];
  let detail: { run: RunRow; items: RunItem[] } | null = null;
  let dbError: string | null = null;
  try {
    const pool = getPool();
    [records] = [await getDiscovery()];
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
