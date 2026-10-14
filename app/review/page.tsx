import Link from "next/link";
import { getPool } from "@/lib/intake/db";
import {
  MAX_LIMIT,
  QUEUE_DOMAINS,
  QUEUE_PRIORITIES,
  getReviewQueue,
  type QueueItem,
  type QueueResult,
} from "@/lib/review/queue";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const TONE: Record<string, "default" | "info" | "success" | "warning" | "danger"> = {
  blocking: "danger",
  high: "warning",
  normal: "info",
  low: "default",
  informational: "default",
};

/** Deterministic age label derived from stored timestamps only (no invented urgency). */
function ageOf(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t) || t <= 0) return "—";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day";
  if (days < 30) return `${days} days`;
  return `${Math.floor(days / 30)} mo`;
}

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{
    domain?: string;
    priority?: string;
    company?: string;
    q?: string;
    offset?: string;
  }>;
}) {
  await requireOperatorPage("/review");
  const sp = await searchParams;
  const filters = {
    domain: sp.domain ?? "",
    priority: sp.priority ?? "",
    company: sp.company ?? "",
    q: sp.q ?? "",
  };
  const parsedOffset = Number.parseInt(sp.offset ?? "0", 10);
  const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;

  let queue: QueueResult | null = null;
  let error: string | null = null;
  try {
    queue = await getReviewQueue(getPool(), { ...filters, limit: PAGE_SIZE, offset });
  } catch (e: unknown) {
    const err = e as { message?: string };
    error = err.message ?? "The review queue could not be loaded.";
  }

  const href = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, ...over }))
      if (v !== "" && v !== undefined) p.set(k, String(v));
    const s = p.toString();
    return `/review${s ? `?${s}` : ""}`;
  };

  const rows = (items: QueueItem[]) =>
    items.map((it) => [
      <span key={`p-${it.key}`} className="inline-flex flex-wrap items-center gap-1">
        <Badge variant={TONE[it.priority] ?? "default"}>{it.priority}</Badge>
        {it.stale && <Badge variant="warning">stale</Badge>}
      </span>,
      <span key={`t-${it.key}`}>
        <span className="text-xs uppercase tracking-wide text-slate-500">{it.domain}</span>
        <span className="block">{it.title}</span>
        <span className="block text-xs text-slate-500">
          status: {it.status}
          {it.companyName ? ` · ${it.companyName}` : ""}
        </span>
      </span>,
      <span key={`w-${it.key}`} className="block text-xs text-slate-600">
        {it.why}
      </span>,
      <span key={`a-${it.key}`} className="text-xs text-slate-600 whitespace-nowrap">
        {ageOf(it.updatedAt)}
      </span>,
      <Link
        key={`o-${it.key}`}
        href={it.href}
        className="text-blue-700 hover:underline"
        aria-label={`Open ${it.title} in its own workflow`}
      >
        Open
      </Link>,
    ]);

  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Evaluation & Review" }, { label: "Review Queue" }]}
        title="Review Queue"
        description="One inbox over every review workflow. Items are projected from live domain state — resolving an item happens in its own workflow, never here. Opportunity scores never set priority; blocking integrity and identity problems always win."
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
              <form
                method="get"
                action="/review"
                className="flex flex-wrap items-end gap-3"
                aria-label="Filter the review queue"
              >
                <div>
                  <Label htmlFor="f-domain">Domain</Label>
                  <select
                    id="f-domain"
                    name="domain"
                    defaultValue={filters.domain}
                    className="flex h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
                  >
                    <option value="">all domains</option>
                    {QUEUE_DOMAINS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="f-priority">Priority</Label>
                  <select
                    id="f-priority"
                    name="priority"
                    defaultValue={filters.priority}
                    className="flex h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
                  >
                    <option value="">all priorities</option>
                    {QUEUE_PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="f-company">Company</Label>
                  <Input
                    id="f-company"
                    name="company"
                    defaultValue={filters.company}
                    placeholder="substring, ≤200 chars"
                    className="w-48"
                  />
                </div>
                <div>
                  <Label htmlFor="f-q">Search title / reason</Label>
                  <Input
                    id="f-q"
                    name="q"
                    defaultValue={filters.q}
                    placeholder="bounded substring, ≤200 chars"
                    className="w-56"
                  />
                </div>
                <button
                  type="submit"
                  className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium hover:bg-slate-50"
                >
                  Apply
                </button>
                <Link href="/review" className="text-sm text-blue-700 hover:underline">
                  Clear
                </Link>
              </form>
              <p className="mt-2 text-xs text-slate-500">
                Search is a bounded substring match over titles, reasons and company names — this
                schema has no full-text index, so coverage is not claimed. Results are capped at{" "}
                {MAX_LIMIT} per page and the newest {queue?.limit ?? PAGE_SIZE} are shown.
              </p>
            </CardContent>
          </Card>

          {queue!.partial && (
            <Alert tone="warning">
              Partial result: {queue!.failedSources.join(", ")} could not be read and is missing from
              this inbox. Everything shown is complete and correct — reload to retry those sources.
            </Alert>
          )}

          <Card>
            <CardHeader>
              <CardTitle>
                Inbox — {queue!.total} item{queue!.total === 1 ? "" : "s"}
                {queue!.total > 0 && (
                  <span className="ml-2 text-xs font-normal text-slate-500">
                    blocking first, then oldest first so nothing starves
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <SimpleTable
                caption="Unified operator review queue"
                columns={["Priority", "Item", "Why it is here", "Age", "Workflow"]}
                rows={rows(queue!.items)}
                empty="No actionable review work matches these filters. Decided, merged, archived and rejected records stay out of the queue by design."
              />
            </CardContent>
          </Card>

          {queue!.total > PAGE_SIZE && (
            <nav aria-label="Review queue pagination" className="flex items-center gap-3 text-sm">
              {offset > 0 && (
                <Link
                  href={href({ offset: String(Math.max(0, offset - PAGE_SIZE)) })}
                  className="text-blue-700 hover:underline"
                >
                  ← Previous
                </Link>
              )}
              <span className="text-slate-600">
                Showing {offset + 1}–{offset + queue!.items.length} of {queue!.total}
              </span>
              {offset + queue!.items.length < queue!.total && (
                <Link
                  href={href({ offset: String(offset + PAGE_SIZE) })}
                  className="text-blue-700 hover:underline"
                >
                  Next →
                </Link>
              )}
            </nav>
          )}

          <p className="text-xs text-slate-500">
            Queue sources:{" "}
            {QUEUE_DOMAINS.map((d, i) => (
              <span key={d}>
                {i > 0 && " · "}
                <Link href={href({ domain: d, offset: "" })} className="text-blue-700 hover:underline">
                  {d}
                </Link>
              </span>
            ))}
            . Items link to the owning workflow; no transition can be performed from this page.
          </p>
        </>
      )}
    </div>
  );
}