import Link from "next/link";
import { getPool } from "@/lib/intake/db";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;
const STATUSES = ["", "observed", "eligible", "ineligible", "promoted", "stale", "archived"];

/**
 * GET /opportunities — accumulated opportunity collection. Every row in the
 * store stays reachable: filters narrow, pagination pages, totals always
 * accompany capped rows. Lower-scoring, unreviewed, exploratory, stale, or
 * excluded records are never hidden — filter them OUT explicitly instead.
 */
export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ pipeline?: string; status?: string; q?: string; offset?: string }>;
}) {
  await requireOperatorPage("/opportunities");
  const sp = await searchParams;
  const pipeline = (sp.pipeline ?? "agency_partner").trim();
  const status = (sp.status ?? "").trim().slice(0, 30);
  const q = (sp.q ?? "").trim().slice(0, 200);
  const parsedOffset = Number.parseInt(sp.offset ?? "0", 10);
  const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;

  let result: { total: number; items: Record<string, unknown>[] } | null = null;
  let error: string | null = null;
  if (pipeline !== "agency_partner" && pipeline !== "direct_client") {
    error = "pipeline must be agency_partner or direct_client.";
  } else {
    try {
      const params: unknown[] = [pipeline];
      const conds = ["o.pipeline = $1"];
      if (status !== "") {
        params.push(status);
        conds.push(`o.status = $${params.length}`);
      }
      if (q !== "") {
        params.push(`%${q}%`);
        conds.push(`(o.opportunity_key ilike $${params.length} or coalesce(c.name, '') ilike $${params.length})`);
      }
      const where = `where ${conds.join(" and ")}`;
      const pool = getPool();
      const total = await pool.query(
        `select count(*)::int as n from public.opportunity o
         left join public.company c on c.id = o.company_id ${where}`,
        params,
      );
      params.push(PAGE_SIZE, offset);
      const rows = await pool.query(
        `select o.id, o.pipeline, o.opportunity_key, o.status, o.solution_status,
                o.first_seen_at, c.id as company_id, c.name as company_name
         from public.opportunity o
         left join public.company c on c.id = o.company_id
         ${where} order by o.created_at desc, o.id asc
         limit $${params.length - 1} offset $${params.length}`,
        params,
      );
      result = { total: total.rows[0].n as number, items: rows.rows as Record<string, unknown>[] };
    } catch {
      error = "Could not load opportunities from the local database.";
    }
  }

  const href = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    const next = { pipeline, status, q, ...over };
    for (const [k, v] of Object.entries(next)) if (v !== "") p.set(k, String(v));
    const s = p.toString();
    return `/opportunities${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Agency Intelligence" }, { label: "Opportunities" }]}
        title="Opportunity collection"
        description="Every discovered opportunity stays reachable here regardless of status. Direct-client rows cannot exist yet (scope undecided, O1) — selecting that pipeline honestly shows nothing."
      />
      <Card>
        <CardHeader><CardTitle>Filters</CardTitle></CardHeader>
        <CardContent>
          <form method="get" action="/opportunities" className="flex flex-wrap items-end gap-3" aria-label="Filter opportunities">
            <div>
              <Label htmlFor="o-pipeline">Pipeline</Label>
              <select id="o-pipeline" name="pipeline" defaultValue={pipeline} className="flex h-9 rounded-md border border-slate-300 bg-white px-2 text-sm">
                <option value="agency_partner">agency_partner</option>
                <option value="direct_client">direct_client</option>
              </select>
            </div>
            <div>
              <Label htmlFor="o-status">Status</Label>
              <select id="o-status" name="status" defaultValue={status} className="flex h-9 rounded-md border border-slate-300 bg-white px-2 text-sm">
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{s === "" ? "all statuses" : s}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="o-q">Search key / agency</Label>
              <Input id="o-q" name="q" defaultValue={q} placeholder="bounded substring, ≤200 chars" className="w-56" />
            </div>
            <button type="submit" className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium hover:bg-slate-50">
              Apply
            </button>
            <Link href="/opportunities" className="text-sm text-blue-700 hover:underline">
              Clear
            </Link>
          </form>
        </CardContent>
      </Card>

      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              Collection — {result!.total} record{result!.total === 1 ? "" : "s"}
              {result!.total > PAGE_SIZE && (
                <span className="ml-2 text-xs font-normal text-slate-500">
                  showing {result!.items.length} per page; nothing hidden
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <SimpleTable
              caption="Accumulated opportunity collection"
              columns={["Opportunity", "Agency", "Status", "Solution check", "Open"]}
              rows={result!.items.map((it) => [
                <span key={`t${it.id as string}`}>
                  <span className="block text-xs text-slate-500">{it.pipeline as string}</span>
                  {it.opportunity_key as string}
                </span>,
                <span key={`c${it.id as string}`}>{(it.company_name as string | null) ?? "—"}</span>,
                <span key={`s${it.id as string}`}>
                  <Badge variant={it.status === "eligible" || it.status === "promoted" ? "success" : it.status === "ineligible" ? "danger" : "default"}>
                    {it.status as string}
                  </Badge>
                </span>,
                <span key={`x${it.id as string}`} className="text-xs text-slate-600">{it.solution_status as string}</span>,
                <Link
                  key={`o${it.id as string}`}
                  href={`/opportunities/${encodeURIComponent(it.opportunity_key as string)}?pipeline=${it.pipeline as string}`}
                  className="text-blue-700 hover:underline"
                >
                  Open
                </Link>,
              ])}
              empty="No opportunities match these filters. Records are never deleted by filtering — broaden the filters."
            />
            {(offset > 0 || offset + result!.items.length < result!.total) && (
              <nav aria-label="Opportunity pagination" className="mt-3 flex items-center gap-3 text-sm">
                {offset > 0 && (
                  <Link href={href({ offset: String(Math.max(0, offset - PAGE_SIZE)) })} className="text-blue-700 hover:underline">
                    ← Previous
                  </Link>
                )}
                <span className="text-slate-600">
                  Showing {result!.total === 0 ? 0 : offset + 1}–{offset + result!.items.length} of {result!.total}
                </span>
                {offset + result!.items.length < result!.total && (
                  <Link href={href({ offset: String(offset + PAGE_SIZE) })} className="text-blue-700 hover:underline">
                    Next →
                  </Link>
                )}
              </nav>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
