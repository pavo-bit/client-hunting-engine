import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";
import { getPool } from "@/lib/intake/db";
import { qualificationQueue } from "@/lib/qualification/dashboard";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

/**
 * GET /qualification — ranked pursuit queue plus the run report. Filters
 * narrow, pagination pages, totals always accompany capped rows. Ineligible
 * and suppressed records never appear as pursuit-ready: only cases whose
 * latest assessment is eligible_for_assessment show a rank; everything else
 * shows its state and reason. Missing scores render as "—", never as zero.
 */
export default async function QualificationPage({
  searchParams,
}: {
  searchParams: Promise<{
    pipeline?: string;
    outcome?: string;
    band?: string;
    service?: string;
    drifted?: string;
    research?: string;
    suppressed?: string;
    sort?: string;
    offset?: string;
  }>;
}) {
  await requireOperatorPage("/qualification");
  const sp = await searchParams;
  const pipeline = (sp.pipeline ?? "").trim();
  const outcome = (sp.outcome ?? "").trim();
  const band = (sp.band ?? "").trim().slice(0, 40);
  const service = (sp.service ?? "").trim().slice(0, 80);
  const drifted = (sp.drifted ?? "").trim() === "true";
  const research = (sp.research ?? "").trim() === "true";
  const showSuppressed = (sp.suppressed ?? "").trim() === "true";
  const sort = (sp.sort ?? "").trim();
  const parsedOffset = Number.parseInt(sp.offset ?? "0", 10);
  const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;

  let result: Awaited<ReturnType<typeof qualificationQueue>> | null = null;
  let error: string | null = null;
  const allowedSorts = ["composite", "updated", "created", "confidence"];
  try {
    result = await qualificationQueue(getPool(), {
      pipeline: pipeline === "" ? undefined : pipeline,
      outcome: outcome === "" ? undefined : outcome,
      band: band === "" ? undefined : band,
      service: service === "" ? undefined : service,
      drifted: drifted || undefined,
      hasResearch: research || undefined,
      hideSuppressed: showSuppressed ? false : undefined,
      sort: (allowedSorts.includes(sort) ? sort : "composite") as "composite" | "updated" | "created" | "confidence",
      limit: PAGE_SIZE,
      offset,
    });
  } catch {
    error = "Could not load the qualification queue from the local database.";
  }

  const href = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    const next: Record<string, string> = { pipeline, outcome, band, service, sort, ...over };
    if (drifted) p.set("drifted", "true");
    if (research) p.set("research", "true");
    // Explicit overrides win: an empty `over.suppressed` clears the toggle.
    if (showSuppressed && !("suppressed" in over)) next.suppressed = "true";
    for (const [k, v] of Object.entries(next)) if (v !== "") p.set(k, String(v));
    for (const [k, v] of Object.entries(next)) if (v !== "") p.set(k, String(v));
    const s = p.toString();
    return `/qualification${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Qualification" }, { label: "Pursuit queue" }]}
        title="Ranked pursuit queue"
        description="Cases with their latest assessment. Rank means eligible + composite + floors; everything else shows why it is not pursuit-ready. Scores are ordinal within one policy version — never probabilities."
      />
      {error || !result ? (
        <Alert tone="error">{error ?? "Could not load."}</Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              Queue — {result.total} case{result.total === 1 ? "" : "s"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form method="get" action="/qualification" className="mb-3 flex flex-wrap items-end gap-3" aria-label="Filter queue">
              <div>
                <label htmlFor="q-outcome" className="text-xs text-slate-600">Eligibility</label>
                <select id="q-outcome" name="outcome" defaultValue={outcome} className="flex h-9 rounded-md border border-slate-300 bg-white px-2 text-sm">
                  <option value="">all outcomes</option>
                  {["eligible_for_assessment", "needs_evidence", "blocked", "not_eligible"].map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="q-sort" className="text-xs text-slate-600">Sort</label>
                <select id="q-sort" name="sort" defaultValue={sort || "composite"} className="flex h-9 rounded-md border border-slate-300 bg-white px-2 text-sm">
                  {allowedSorts.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="q-service" className="text-xs text-slate-600">Service (matches fit explanation)</label>
                <input id="q-service" name="service" defaultValue={service} placeholder="service id substring" className="flex h-9 rounded-md border border-slate-300 bg-white px-2 text-sm" />
              </div>
              <button type="submit" className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium hover:bg-slate-50">
                Apply
              </button>
              <Link href="/qualification" className="text-sm text-blue-700 hover:underline">Clear</Link>
              {showSuppressed ? (
                <Link href={href({ suppressed: "" })} className="text-sm text-blue-700 hover:underline">
                  Hide suppressed
                </Link>
              ) : (
                <Link href={href({ suppressed: "true" })} className="text-sm text-blue-700 hover:underline">
                  Include suppressed (audit)
                </Link>
              )}
            </form>
            <SimpleTable
              caption="Qualification queue"
              columns={["Case", "Agency", "Outcome", "Composite", "Band", "Decision", "Tasks", "Open"]}
              rows={result.rows.map((r) => [
                <span key={`c${r.case_id}`} className="font-mono text-xs" title={r.discovery_opportunity_key}>
                  {r.case_ref}
                </span>,
                <span key={`n${r.case_id}`}>{r.company_name ?? "—"}</span>,
                <span key={`o${r.case_id}`}>
                  {r.latest_outcome ? (
                    <Badge variant={r.latest_outcome === "eligible_for_assessment" ? "success" : r.latest_outcome === "not_eligible" ? "danger" : "warning"}>
                      {r.latest_outcome}
                    </Badge>
                  ) : (
                    <span className="text-xs text-slate-500">unassessed</span>
                  )}
                  {r.drift_detected_at && (
                    <span className="ml-1 text-xs text-amber-700" title="Discovery moved since reconciliation">drift</span>
                  )}
                </span>,
                <span key={`s${r.case_id}`}>{r.latest_composite === null ? "—" : r.latest_composite}</span>,
                <span key={`b${r.case_id}`}>{r.latest_band ?? "—"}</span>,
                <span key={`d${r.case_id}`}>
                  {r.latest_decision ? (
                    <Badge variant={r.latest_decision === "accepted" ? "success" : r.latest_decision === "rejected" ? "danger" : "default"}>
                      {r.latest_decision}
                    </Badge>
                  ) : (
                    <span className="text-xs text-slate-500">undecided</span>
                  )}
                </span>,
                <span key={`t${r.case_id}`}>{r.open_tasks > 0 ? `${r.open_tasks} open` : "—"}</span>,
                <Link key={`o${r.case_id}`} href={`/qualification/cases/${r.case_id}`} className="text-blue-700 hover:underline">
                  Open
                </Link>,
              ])}
              empty="No cases match. Backfill from /admin to import assessed history; assess from the case page."
            />
            {(offset > 0 || offset + result.rows.length < result.total) && (
              <nav aria-label="Queue pagination" className="mt-3 flex items-center gap-3 text-sm">
                {offset > 0 && (
                  <Link href={href({ offset: String(Math.max(0, offset - PAGE_SIZE)) })} className="text-blue-700 hover:underline">
                    ← Previous
                  </Link>
                )}
                <span className="text-slate-600">
                  Showing {result.total === 0 ? 0 : offset + 1}–{offset + result.rows.length} of {result.total}
                </span>
                {offset + result.rows.length < result.total && (
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
