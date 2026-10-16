import Link from "next/link";
import { getPool } from "@/lib/intake/db";
import {
  fetchAgencyDirectory,
  parseAgencyFilters,
  AGENCY_SORT_COLUMNS,
  COMPANY_STATUSES,
  PER_PAGE_OPTIONS,
  type AgencySortKey,
} from "@/lib/dashboard/agency-query";
import { AgencyTable } from "@/components/agency-table";
import { ExportButton } from "@/components/export-button";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

/**
 * Server-side filters + sort + pagination. The export button passes the SAME
 * query string to /api/export, so the download and the screen cannot diverge.
 */
export default async function AgenciesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperatorPage("/agencies");
  const sp = await searchParams;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const one = Array.isArray(v) ? v[0] : v;
    if (typeof one === "string" && one !== "") params.set(k, one);
  }
  const filters = parseAgencyFilters(params);

  let data = null;
  let error: string | null = null;
  try {
    data = await fetchAgencyDirectory(getPool(), filters);
  } catch {
    error = "Could not load agencies from the local database. Is Docker PostgreSQL running (docker compose up)?";
  }

  /** Rebuild the current view with one parameter changed. */
  const link = (patch: Record<string, string | null>): string => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    next.delete("page");
    const qs = next.toString();
    return qs === "" ? "/agencies" : `/agencies?${qs}`;
  };

  const exportQuery = params.toString();
  const sortLink = (key: AgencySortKey): string =>
    link({ sort: key, dir: filters.sort === key && filters.dir === "asc" ? "desc" : "asc" });
  const pageHref = (n: number): string => {
    const next = new URLSearchParams(params);
    next.set("page", String(n));
    return `/agencies?${next.toString()}`;
  };
  const prevHref = data && data.page > 1 ? pageHref(data.page - 1) : null;
  const nextHref = data && data.page < data.pageCount ? pageHref(data.page + 1) : null;

  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Agency Intelligence" }, { label: "Directory" }]}
        title="Agency directory"
        description="Canonical agency records from intake. Worldwide scope; country is an attribute, not a restriction."
      />

      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Filters</CardTitle>
            </CardHeader>
            <CardContent>
              <form method="get" action="/agencies" className="grid gap-3 md:grid-cols-4">
                <div>
                  <Label htmlFor="f-q">Search</Label>
                  <Input id="f-q" name="q" defaultValue={filters.q} placeholder="name, domain, registry, country" />
                </div>
                <div>
                  <Label htmlFor="f-country">Country</Label>
                  <select
                    id="f-country"
                    name="country"
                    defaultValue={filters.country ?? ""}
                    className="flex h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                  >
                    <option value="">All</option>
                    {data!.facets.countries.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="f-type">Type</Label>
                  <select
                    id="f-type"
                    name="agencyType"
                    defaultValue={filters.agencyType ?? ""}
                    className="flex h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                  >
                    <option value="">All</option>
                    {data!.facets.agencyTypes.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="f-status">Workflow state</Label>
                  <select
                    id="f-status"
                    name="status"
                    defaultValue={filters.status ?? ""}
                    className="flex h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                  >
                    <option value="">All</option>
                    {COMPANY_STATUSES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="f-per">Per page</Label>
                  <select
                    id="f-per"
                    name="perPage"
                    defaultValue={String(filters.perPage)}
                    className="flex h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                  >
                    {PER_PAGE_OPTIONS.map((n) => (
                      <option key={n} value={String(n)}>{n}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-end gap-2">
                  <button type="submit" className="h-9 rounded-md bg-slate-900 px-3 text-sm text-white">
                    Apply
                  </button>
                  <Link href="/agencies" className="text-sm text-blue-700 hover:underline">
                    Reset
                  </Link>
                </div>
              </form>
              <p className="mt-2 text-xs text-slate-500">
                Workflow state (candidate / resolved / qualified / rejected / archived) is
                lifecycle, not a qualification verdict. Verdicts live on qualification cases.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>
                  Agencies ({data!.total}
                  {filters.q ? ` matching “${filters.q}”` : ""})
                </CardTitle>
                <ExportButton query={exportQuery} />
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-3 text-xs text-slate-600">
                {(["name", "agency_type", "country", "discovery_status", "created_at"] as AgencySortKey[]).map((k) => (
                  <Link
                    key={k}
                    href={sortLink(k)}
                    className="underline decoration-dotted hover:text-slate-900"
                    aria-label={`Sort by ${k}`}
                  >
                    sort: {k}
                    {filters.sort === k ? (filters.dir === "asc" ? " ↑" : " ↓") : ""}
                  </Link>
                ))}
              </div>
              <AgencyTable rows={data!.rows} />
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
                <span className="text-xs text-slate-500">
                  Page {data!.page} of {data!.pageCount} · {data!.total} matching record(s)
                </span>
                <span className="flex gap-2 text-sm">
                  {prevHref && (
                    <Link href={prevHref} className="text-blue-700 hover:underline">
                      ← Previous
                    </Link>
                  )}
                  {nextHref && (
                    <Link href={nextHref} className="text-blue-700 hover:underline">
                      Next →
                    </Link>
                  )}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>How to read this page</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-xs text-slate-600">
              <p>
                <Badge variant="info">synthetic</Badge> marks development fixtures using
                fictional <code>.example</code> domains.
              </p>
              <p>
                Evidence counts distinct observation snapshots and attribute the newest one
                to a source key. A company with zero evidence has no provenance — that is
                missing information, not a clean record.
              </p>
              <p>
                Open a record to read its claims, aliases, duplicate candidates and
                identity history. Record new evidence from the{" "}
                <Link href="/evidence" className="underline">evidence ledger</Link>.
              </p>
              <p>
                Exports contain company fields and evidence attribution only — no claim
                text, no raw payloads, no credentials.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}