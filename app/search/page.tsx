import Link from "next/link";
import { getPool } from "@/lib/intake/db";
import { globalSearch, SEARCH_MAX, SEARCH_MIN, type GlobalSearchResult } from "@/lib/search/global";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

const GROUPS: { key: "companies" | "claims" | "hypotheses" | "proposals" | "briefs"; label: string }[] = [
  { key: "companies", label: "Agencies" },
  { key: "claims", label: "Claims" },
  { key: "hypotheses", label: "Hypotheses" },
  { key: "proposals", label: "Proposals" },
  { key: "briefs", label: "Briefs" },
];

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireOperatorPage("/search");
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  let result: GlobalSearchResult | null = null;
  let error: string | null = null;
  if (q !== "") {
    try {
      result = await globalSearch(getPool(), q);
    } catch (e: unknown) {
      error = (e as Error).message ?? "Search failed.";
    }
  }

  const total = result
    ? result.companies.total + result.claims.total + result.hypotheses.total + result.proposals.total + result.briefs.total
    : 0;

  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Agency Intelligence" }, { label: "Search" }]}
        title="Global search"
        description={`One search across agencies, claims, hypotheses, proposals, and briefs. Ranked exact → prefix → substring → similarity; deterministic ties. Needs ${SEARCH_MIN}–${SEARCH_MAX} characters; queries are never logged.`}
      />
      <Card>
        <CardHeader><CardTitle>Search</CardTitle></CardHeader>
        <CardContent>
          <form method="get" action="/search" className="flex flex-wrap items-end gap-3" aria-label="Global search">
            <div className="min-w-64 flex-1">
              <Label htmlFor="gq">Query</Label>
              <Input id="gq" name="q" defaultValue={q} placeholder="portal, onboarding, BR-2026-001…" autoComplete="off" />
            </div>
            <button
              type="submit"
              className="h-9 rounded-md bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-700"
            >
              Search
            </button>
          </form>
        </CardContent>
      </Card>

      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : result ? (
        <>
          <p className="text-sm text-slate-600" role="status">
            {total === 0
              ? `No matches for “${result.query}”. Nothing is hidden — try fewer or shorter words.`
              : `${total} match${total === 1 ? "" : "es"} for “${result.query}” (showing up to ${result.perDomain} per group).`}
          </p>
          {GROUPS.map(({ key, label }) => {
            const g = result![key];
            if (g.rows.length === 0) return null;
            return (
              <Card key={key}>
                <CardHeader>
                  <CardTitle>
                    {label} ({g.rows.length}{g.total > g.rows.length ? ` of ${g.total}` : ""})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <SimpleTable
                    caption={`${label} matches`}
                    columns={["Match", "Agency", "Status", "Open"]}
                    rows={g.rows.map((hit) => [
                      <span key={`t${hit.id}`}>
                        {hit.title}
                        {hit.snippet && hit.snippet !== hit.title && (
                          <span className="block text-xs text-slate-500">{hit.snippet.slice(0, 160)}</span>
                        )}
                      </span>,
                      <span key={`c${hit.id}`}>{hit.companyName ?? "—"}</span>,
                      <span key={`s${hit.id}`}>
                        <Badge variant="default">{hit.status}</Badge>
                      </span>,
                      <Link key={`o${hit.id}`} href={hit.href} className="text-blue-700 hover:underline">
                        Open
                      </Link>,
                    ])}
                    empty={`No ${label.toLowerCase()} matches.`}
                  />
                </CardContent>
              </Card>
            );
          })}
        </>
      ) : (
        <Alert tone="info">Enter at least {SEARCH_MIN} characters to search all five record types at once.</Alert>
      )}
    </div>
  );
}
