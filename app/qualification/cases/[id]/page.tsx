import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/intake/db";
import { PageHeader } from "@/components/page-header";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTable } from "@/components/data-table";
import { requireOperatorPage } from "@/lib/auth/guard";
import { buildEvidenceBundle, safeSourceUrl } from "@/lib/qualification/evidence";
import { assessmentStaleness } from "@/lib/qualification/assessments";
import { caseDisplayState, decisionHistory, latestDecision } from "@/lib/qualification/decisions";
import { readQualificationRow, type QualificationRow } from "@/lib/qualification/view";
import { DecisionForm } from "@/components/qualification/decision-form";

export const dynamic = "force-dynamic";

/** Derived research display states (frozen contract has 4 statuses; these derive at read time). */
function taskDisplay(task: Record<string, unknown>, negForSnapshot: Set<string>): string {
  const status = task.status as string;
  if (status === "dismissed") return "Cancelled";
  if (status === "done") {
    return negForSnapshot.has(task.snapshot_id as string) ? "DoneNoneFound" : "DoneFound";
  }
  const due = task.due_at ? new Date(task.due_at as string) : null;
  if ((status === "open" || status === "accepted") && due && due <= new Date()) return "Expired (overdue)";
  return status === "open" ? "Open" : "InProgress";
}

/**
 * GET /qualification/cases/[id] — one case, fully explainable: identity and
 * confidence, service fit, need reasoning, supporting and contradicting
 * evidence with grades/independence/freshness, timing, dimensions, missing
 * data and gates, solution checks, engagement route, delivery feasibility,
 * assessments, rank explanation, next research, audit and decisions.
 * Untrusted source text renders escaped (React default); URLs become links
 * only when http(s) without control characters.
 */
export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOperatorPage("/qualification/cases/[id]");
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const pool = getPool();
  const kase = await pool.query("select * from p2.case where case_id = $1", [id]);
  if (kase.rows.length === 0) notFound();
  const c = kase.rows[0] as Record<string, unknown>;
  const opportunityId = c.discovery_opportunity_id as string;
  const row = (await readQualificationRow(pool, opportunityId)) as QualificationRow | null;

  const assessments = (
    await pool.query(
      `select assessment_id, version, policy_version, service_catalog_version, rubric_version,
              capacity_version, as_of, decided_by, decided_at, note, assessment
       from p2.case_assessment where case_id = $1 order by version`,
      [id],
    )
  ).rows as Record<string, unknown>[];
  const latest = assessments[assessments.length - 1] as
    | { assessment_id: string; assessment: Record<string, unknown> }
    | undefined;
  const score = latest ? (latest.assessment as Record<string, unknown>) : null;
  const staleness = latest ? await assessmentStaleness(pool, latest.assessment_id) : null;
  const decisions = await decisionHistory(pool, id);
  const latestDec = await latestDecision(pool, id);
  const display = caseDisplayState({
    caseStatus: c.status as string,
    latestDecision: latestDec,
    latestOutcome: (score?.outcome as string | undefined) ?? null,
    suppression: row ? ((row.suppression_reason as string | null) ?? null) : null,
    stale: staleness ? staleness.stale : false,
    deferralOverdue:
      latestDec?.decision === "deferred" &&
      latestDec.resume_at !== null &&
      new Date(latestDec.resume_at) <= new Date(),
  });

  let bundle: Awaited<ReturnType<typeof buildEvidenceBundle>> | null = null;
  if (row && row.company_id) {
    try {
      // Signal families come from the ACTIVE policy when one exists (display
      // only — the recorded assessments keep whatever map they ran with).
      let signalMap: Record<string, string> = {};
      let freshDays = 90;
      const active = await pool.query(
        "select version from p2.reference_version where kind = 'policy' and status = 'active' order by recorded_at desc limit 1",
      );
      if (active.rows[0]?.version) {
        const def = await pool.query("select definition from p2.scoring_policy where policy_version = $1", [
          active.rows[0].version,
        ]);
        const d = def.rows[0]?.definition as { signalMap?: Record<string, string>; freshnessDefaultDays?: number } | undefined;
        if (d) {
          signalMap = d.signalMap ?? {};
          freshDays = d.freshnessDefaultDays ?? 90;
        }
      }
      bundle = await buildEvidenceBundle(pool, row.company_id as string, {
        asOf: new Date().toISOString(),
        signalMap,
        freshnessDefaultDays: freshDays,
      });
    } catch {
      bundle = null;
    }
  }
  const tasks = (
    await pool.query(
      `select task_id, snapshot_id, question, reason_code, dimension, gate, evidence_needed,
              expected_impact, uncertainty, source_availability, effort_estimate,
              priority_explanation, status, operator_notes, due_at, created_at
       from p2.research_task where case_id = $1 order by created_at, task_id`,
      [id],
    )
  ).rows as Record<string, unknown>[];
  const negSnapshots = new Set(
    (
      (await pool.query("select distinct snapshot_id from p2.negative_finding where case_id = $1", [id]))
        .rows as { snapshot_id: string }[]
    ).map((r) => r.snapshot_id),
  );
  const snapshots = (
    await pool.query(
      "select snapshot_id, schema_version, row_hash, captured_at, captured_by, captured_reason from p2.case_snapshot where case_id = $1 order by captured_at",
      [id],
    )
  ).rows as Record<string, unknown>[];
  const rankings = (
    await pool.query(
      `select ranking_id, created_at, created_by, ordered from p2.ranking_snapshot
       where ordered @> $1::jsonb order by created_at desc limit 3`,
      [JSON.stringify([{ case_id: id }])],
    )
  ).rows as Record<string, unknown>[];

  const dims = (score?.dimensions as Record<string, { score: number | null; explanation: string; evidenceRefs: string[]; missing: string[]; flags: string[] }> | undefined) ?? null;
  const supporting = bundle?.items.filter((i) => i.polarity === "supports") ?? [];
  const contradicting = bundle?.items.filter((i) => i.polarity === "contradicts") ?? [];
  const contextual = bundle?.items.filter((i) => i.polarity !== "supports" && i.polarity !== "contradicts") ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        trail={[{ label: "Qualification" }, { label: "Pursuit queue", href: "/qualification" }, { label: (c.case_ref as string) ?? id.slice(0, 8) }]}
        title={`${(row?.company_name as string | null) ?? "Unknown business"} — ${display.state}`}
        description={`Case ${c.case_ref as string} · pipeline ${c.pipeline as string} ·Statuses describe review state — never purchasing intent.`}
      />
      {display.stale && (
        <Alert tone="warning">
          Latest assessment is stale ({staleness?.reasons.join("; ")}). Re-run assessment before deciding —
          accept/defer on it will be refused.
        </Alert>
      )}
      {row && row.suppression_reason != null && (
        <Alert tone="error">
          Suppressed ({String(row.suppression_reason)}) — review cannot pursue this case. Reject or withdraw it.
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Business identity</CardTitle></CardHeader>
          <CardContent>
            <SimpleTable
              caption="Identity and matching confidence"
              columns={["Field", "Value"]}
              rows={[
                ["Business", String(row?.company_name ?? "—")],
                ["Domain", String(row?.company_domain_norm ?? "— (registry-sourced, no domain)")],
                ["Registry", String(row?.company_registry_id ?? "—")],
                ["Agency type", String(row?.company_agency_type ?? "—")],
                ["Country", String(row?.company_country ?? "—")],
                ["Entity confidence", bundle ? `${bundle.items[0]?.entityConfidence ?? "—"} — ${bundle.items[0]?.entityBasis ?? "no evidence"}` : "no evidence bundle"],
                ["Ambiguity", bundle?.ambiguousEntity ? "OPEN identity conflict — match unverified" : "none open"],
                ["Opportunity", String(row?.opportunity_key ?? "—")],
              ]}
              empty="No identity."
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Eligibility and rank</CardTitle></CardHeader>
          <CardContent>
            <SimpleTable
              caption="Current qualification state"
              columns={["Field", "Value"]}
              rows={[
                ["Display state", display.state + (display.stale ? " (stale assessment)" : "") + (display.overdue ? " (deferral overdue)" : "")],
                ["Gate outcome", String(score?.outcome ?? "not yet assessed")],
                ["Composite", score && score.composite !== null && score.composite !== undefined ? String(score.composite) : "— (missing data, never zero-filled)"],
                ["Band", String((score?.band as string | null) ?? "—")],
                ["Latest assessment", latest ? `v${(latest as Record<string, unknown>).version as number}` : "none"],
                ["Latest decision", latestDec ? `${latestDec.decision} by ${latestDec.actor}` : "undecided"],
              ]}
              empty="Nothing assessed."
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Dimension profile</CardTitle></CardHeader>
        <CardContent>
          {dims ? (
            <SimpleTable
              caption="Dimension scores with rationales"
              columns={["Dimension", "Score", "Rationale", "Missing"]}
              rows={Object.entries(dims).map(([d, v]) => [
                <span key={`d${d}`}>{d}</span>,
                <span key={`s${d}`}>{v.score === null ? "— (unscored)" : v.score}</span>,
                <span key={`e${d}`} className="block max-w-2xl whitespace-pre-wrap text-xs text-slate-600">{v.explanation}</span>,
                <span key={`m${d}`} className="block max-w-xl whitespace-pre-wrap text-xs text-amber-700">
                  {(v.missing as string[]).join("; ") || "—"}
                </span>,
              ])}
              empty="No dimensions."
            />
          ) : (
            <p className="text-sm text-slate-500">Not yet assessed — run an assessment to score dimensions.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Evidence — supporting ({supporting.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Supporting evidence with grade, independence and freshness"
            columns={["Claim", "Grade", "Group", "Freshness", "Source"]}
            rows={supporting.map((i) => {
              const url = safeSourceUrl(i.sourceUrl);
              return [
                <span key={`t${i.claimId}`} className="block max-w-xl whitespace-pre-wrap text-xs">
                  {i.normalizedText}
                  {i.lowConfidence && <span className="ml-1 text-amber-700">(low-confidence source)</span>}
                </span>,
                <span key={`g${i.claimId}`} className="text-xs">{i.trustGrade}{i.approved ? "" : " (unapproved)"}</span>,
                <span key={`i${i.claimId}`} className="text-xs">{i.independenceGroup}</span>,
                <span key={`f${i.claimId}`} className="text-xs">{i.freshness}{i.ageDays !== null ? ` (${i.ageDays}d)` : ""}</span>,
                url ? (
                  <a key={`u${i.claimId}`} href={url} target="_blank" rel="noreferrer" className="text-xs text-blue-700 hover:underline">
                    {i.sourceKey ?? "unknown"}
                  </a>
                ) : (
                  <span key={`u${i.claimId}`} className="text-xs text-slate-500">{i.sourceKey ?? "unknown"} (no linkable URL)</span>
                ),
              ];
            })}
            empty="No supporting evidence recorded."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Contradictions ({contradicting.length}) and context ({contextual.length})</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="What argues against the hypothesis"
            columns={["Claim", "Polarity", "Grade", "Source"]}
            rows={[...contradicting, ...contextual].map((i) => [
              <span key={`t${i.claimId}`} className="block max-w-xl whitespace-pre-wrap text-xs">{i.normalizedText}</span>,
              <span key={`p${i.claimId}`}>
                <Badge variant={i.polarity === "contradicts" ? "danger" : "default"}>{i.polarity}</Badge>
              </span>,
              <span key={`g${i.claimId}`} className="text-xs">{i.trustGrade}</span>,
              <span key={`s${i.claimId}`} className="text-xs">{i.sourceKey ?? "unknown"}</span>,
            ])}
            empty="No contradicting or contextual evidence — absence of contradiction is not proof of need."
          />
          {bundle && (bundle.duplicates.length > 0 || bundle.unapproved.length > 0 || bundle.expired.length > 0) && (
            <p className="mt-2 text-xs text-slate-600">
              Governed out of scoring: {bundle.duplicates.length} duplicate(s), {bundle.unapproved.length}{" "}
              unapproved-source item(s), {bundle.expired.length} expired — listed, never counted.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Assessments ({assessments.length})</CardTitle></CardHeader>
          <CardContent>
            <SimpleTable
              caption="Assessment history (immutable)"
              columns={["v", "Outcome", "Composite", "By", "At"]}
              rows={assessments.map((a) => {
                const s = a.assessment as unknown as Record<string, unknown>;
                return [
                  <span key={`v${a.assessment_id as string}`}>v{a.version as number}</span>,
                  <span key={`o${a.assessment_id as string}`}>{String(s.outcome ?? "?")}</span>,
                  <span key={`c${a.assessment_id as string}`}>{s.composite === null || s.composite === undefined ? "—" : String(s.composite)}</span>,
                  <span key={`b${a.assessment_id as string}`} className="text-xs">{a.decided_by as string}</span>,
                  <span key={`t${a.assessment_id as string}`} className="text-xs text-slate-600">
                    {new Date(a.decided_at as string).toLocaleString()}
                  </span>,
                ];
              })}
              empty="No assessments yet."
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Rank history</CardTitle></CardHeader>
          <CardContent>
            <SimpleTable
              caption="Ranking snapshots containing this case"
              columns={["When", "Rank", "Composite", "Inputs"]}
              rows={rankings.map((r) => {
                const entry = ((r.ordered as { case_id: string; rank: number; composite: number }[])).find((e) => e.case_id === id);
                return [
                  <span key={`w${r.ranking_id as string}`} className="text-xs">{new Date(r.created_at as string).toLocaleString()}</span>,
                  <span key={`r${r.ranking_id as string}`}>{entry && entry.rank > 0 ? `#${entry.rank}` : "excluded"}</span>,
                  <span key={`c${r.ranking_id as string}`}>{entry ? String(entry.composite) : "—"}</span>,
                  <span key={`i${r.ranking_id as string}`} className="font-mono text-xs" title="reproducibility hash">
                    {(r as Record<string, unknown>).input_hash
                      ? String((r as Record<string, unknown>).input_hash).slice(0, 12)
                      : (Array.isArray(r.ordered) ? `${(r.ordered as unknown[]).length} leads` : "")}
                  </span>,
                ];
              })}
              empty="No ranking snapshot contains this case yet."
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Research ({tasks.length}) — next question first</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Research tasks by decision value"
            columns={["Question", "State", "Impact/Effort", "Due", "Notes"]}
            rows={tasks.map((t) => [
              <span key={`q${t.task_id as string}`} className="block max-w-xl whitespace-pre-wrap text-xs">
                {t.question as string}
                <span className="block text-slate-500">affects {String((t.dimension as string | null) ?? (t.gate as string ?? "?"))} · {t.reason_code as string}</span>
              </span>,
              <span key={`s${t.task_id as string}`}>
                <Badge variant={(t.status as string) === "done" ? "success" : "default"}>
                  {taskDisplay(t, negSnapshots)}
                </Badge>
              </span>,
              <span key={`e${t.task_id as string}`} className="text-xs">{t.expected_impact as string}/{t.effort_estimate as string}</span>,
              <span key={`u${t.task_id as string}`} className="text-xs">{t.due_at ? new Date(t.due_at as string).toLocaleDateString() : "—"}</span>,
              <span key={`n${t.task_id as string}`} className="block max-w-xl whitespace-pre-wrap text-xs text-slate-600">
                {(t.operator_notes as string | null) ?? "—"}
              </span>,
            ])}
            empty="No research questions. Assessments propose them automatically; the operator can add more from /qualification/research."
          />
          <p className="mt-2 text-xs text-slate-500">
            Manage status, due flags and notes in the <Link href="/qualification/research" className="text-blue-700 hover:underline">research workspace</Link>.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Record a review decision</CardTitle></CardHeader>
        <CardContent>
          <DecisionForm
            caseId={id}
            assessments={assessments.map((a) => ({ assessment_id: a.assessment_id as string, version: a.version as number }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Lifecycle and audit</CardTitle></CardHeader>
        <CardContent>
          <SimpleTable
            caption="Human decisions (immutable)"
            columns={["Decision", "Reason", "Actor", "At"]}
            rows={decisions.map((d) => [
              <span key={`d${d.decision_id}`}><Badge variant={d.decision === "accepted" ? "success" : d.decision === "rejected" ? "danger" : "default"}>{d.decision}</Badge></span>,
              <span key={`r${d.decision_id}`} className="block max-w-xl whitespace-pre-wrap text-xs">{d.reason}{d.resume_at ? ` — resume ${new Date(d.resume_at).toLocaleDateString()}` : ""}{d.resume_condition ? ` — ${d.resume_condition}` : ""}</span>,
              <span key={`a${d.decision_id}`} className="text-xs">{d.actor}</span>,
              <span key={`t${d.decision_id}`} className="text-xs text-slate-600">{new Date(d.decided_at).toLocaleString()}</span>,
            ])}
            empty="No human decisions yet."
          />
          <p className="mt-2 text-xs text-slate-500">
            Snapshots retained: {snapshots.length} · Corrections cite a new assessment — records are never edited.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
