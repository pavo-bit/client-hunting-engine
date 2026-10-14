import Link from "next/link";
import { getPool } from "@/lib/intake/db";
import { checkGates, rankedOpportunities, scoreHistory } from "@/lib/scoring/evaluate";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export default async function ScoresPage() {
  await requireOperatorPage("/scores");
  let ranking = null;
  let ineligible: { id: string; title: string; reasons: string[] }[] = [];
  let histories: Record<string, { total: number; band: string; model_version: string }[]> = {};
  try {
    const pool = getPool();
    ranking = await rankedOpportunities(pool);
    const all = await pool.query(
      `select h.id, h.title from public.hypothesis h order by h.created_at desc limit 200`,
    );
    const rankedIds = new Set(ranking.map((r) => r.hypothesis_id));
    for (const row of all.rows as { id: string; title: string }[]) {
      if (rankedIds.has(row.id)) continue;
      const { eligible, gates } = await checkGates(pool, row.id);
      if (!eligible) {
        ineligible.push({
          id: row.id,
          title: row.title,
          reasons: gates.filter((g) => !g.passed).map((g) => `${g.id}: ${g.reason}`),
        });
      }
    }
    for (const r of ranking) {
      const h = await scoreHistory(pool, r.hypothesis_id);
      histories[r.hypothesis_id] = h.map((x) => ({
        total: x.total as number,
        band: x.band as string,
        model_version: x.model_version as string,
      }));
    }
  } catch {
    return (
      <div className="space-y-4">
        <PageHeader trail={[{ label: "Evaluation & Review" }, { label: "Ranking" }]} title="Opportunity Ranking" />
        <Alert tone="error">Local database unreachable.</Alert>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Evaluation & Review" }, { label: "Ranking" }]}
        title="Opportunity Ranking"
        description="Deterministic score_v1 (provisional weights, D-006). Scores summarize inspectable criteria — a number never overrides a failed gate, and weak evidence can never look objective."
      />
      <Card>
        <CardHeader><CardTitle>Ranked eligible opportunities ({ranking.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Ranked opportunities"
            columns={["#", "Agency", "Hypothesis", "Score", "Model", "Freshness", "History"]}
            rows={ranking.map((s, i) => [
              <span key={`n${s.hypothesis_id}`}>{i + 1}</span>,
              <span key={`c${s.hypothesis_id}`}>{s.company_name}</span>,
              <Link key={`t${s.hypothesis_id}`} href={`/hypotheses/${s.hypothesis_id}`} className="text-blue-700 hover:underline">
                {s.title}
              </Link>,
              <span key={`v${s.hypothesis_id}`}>
                <strong>{s.total}</strong> ({s.band})
                {s.partial && <Badge variant="warning">partial inputs</Badge>}
              </span>,
              <code key={`m${s.hypothesis_id}`} className="text-xs">{s.model_version}</code>,
              s.stale ? (
                <Badge key={`f${s.hypothesis_id}`} variant="warning">
                  stale: {s.staleReasons.join("; ")}
                </Badge>
              ) : (
                <span key={`f${s.hypothesis_id}`}>current</span>
              ),
              <span key={`h${s.hypothesis_id}`} className="text-xs text-slate-600">
                {(histories[s.hypothesis_id] ?? []).map((h) => `${h.total}${h.model_version !== "score_v1" ? ` (${h.model_version})` : ""}`).join(" → ") || "—"}
              </span>,
            ])}
            empty="No eligible opportunities. Evaluate hypotheses to rank them — ineligible ones appear below with reasons, never with scores."
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Excluded by hard gates ({ineligible.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Gate failures"
            columns={["Hypothesis", "Failed gates"]}
            rows={ineligible.map((g) => [
              <Link key={`t${g.id}`} href={`/hypotheses/${g.id}`} className="text-blue-700 hover:underline">
                {g.title}
              </Link>,
              <span key={`r${g.id}`} className="text-xs text-slate-600">{g.reasons.join("; ")}</span>,
            ])}
            empty="No exclusions — every hypothesis currently passes its gates."
          />
        </CardContent>
      </Card>
      <Alert tone="info">
        Ties break by total desc, evaluated-at asc, hypothesis id asc. Weights
        are provisional; empirical calibration needs ≥30 reviewed outcomes with
        recorded decisions (see calibration protocol). Scores are not
        probabilities and never predict revenue.
      </Alert>
    </div>
  );
}
