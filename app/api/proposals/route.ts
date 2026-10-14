import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { createProposal } from "@/lib/proposal/proposals";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/**
 * POST /api/proposals — explicit proposal creation from a validated
 * hypothesis. Nothing auto-generates: the operator supplies scope, line
 * items, assumptions, and optional price/timeline ranges. Effort ranges come
 * from the versioned estimation model; insufficient line items yield no
 * estimate (never fabricated precision).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireOperatorApi(req);
  if (!auth.ok) return auth.response!;
  const csrf = requireSameOrigin(req, auth);
  if (csrf) return csrf;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { code: "bad_json", message: "request body must be JSON" },
      { status: 400 },
    );
  }
  try {
    const items = Array.isArray(body["items"])
      ? (body["items"] as Record<string, unknown>[]).map((it) => ({
          name: typeof it["name"] === "string" ? it["name"] : "",
          complexity: it["complexity"] as "S" | "M" | "L" | "XL",
          kind: it["kind"] as
            | "feature"
            | "integration"
            | "data_migration"
            | "security"
            | "testing",
        }))
      : undefined;
    const result = await createProposal(getPool(), {
      hypothesisId: typeof body["hypothesisId"] === "string" ? body["hypothesisId"] : "",
      title: typeof body["title"] === "string" ? body["title"] : "",
      scopeIn: str(body["scopeIn"]),
      scopeOut: str(body["scopeOut"]),
      milestones: str(body["milestones"]),
      feasibility: body["feasibility"] as "high" | "medium" | "low" | "unknown",
      capabilityFit: str(body["capabilityFit"]),
      assumptions: typeof body["assumptions"] === "string" ? body["assumptions"] : "",
      impactNote: str(body["impactNote"]),
      dependencies: str(body["dependencies"]),
      validationQuestions: str(body["validationQuestions"]),
      capabilityKeys: Array.isArray(body["capabilityKeys"])
        ? (body["capabilityKeys"] as unknown[]).filter((k): k is string => typeof k === "string")
        : undefined,
      items,
      contingencyPct: num(body["contingencyPct"]) ?? undefined,
      unknowns: Array.isArray(body["unknowns"])
        ? (body["unknowns"] as unknown[]).filter((u): u is string => typeof u === "string")
        : undefined,
      costLow: num(body["costLow"]),
      costHigh: num(body["costHigh"]),
      costCurrency: str(body["costCurrency"]),
      pricingModel: (body["pricingModel"] ?? null) as
        | "fixed_scope"
        | "time_and_materials"
        | "not_defined"
        | null,
      taxNote: str(body["taxNote"]),
      timelineLoWeeks: num(body["timelineLoWeeks"]),
      timelineHiWeeks: num(body["timelineHiWeeks"]),
      actor: (auth.email ?? actorOf(body)),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}

/** GET /api/proposals?hypothesis=&status= — bounded list (read-only). */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireOperatorApi(req);
  if (!auth.ok) return auth.response!;
  const url = new URL(req.url);
  const hypothesis = (url.searchParams.get("hypothesis") ?? "").slice(0, 100);
  const status = (url.searchParams.get("status") ?? "").slice(0, 30);
  try {
    const params: unknown[] = [];
    const conds: string[] = [];
    if (hypothesis !== "") {
      params.push(hypothesis);
      conds.push(`p.hypothesis_id = $${params.length}`);
    }
    if (status !== "") {
      params.push(status);
      conds.push(`p.status = $${params.length}`);
    }
    params.push(500);
    const r = await getPool().query(
      `select p.id, p.hypothesis_id, h.title as hypothesis_title,
              c.name as company_name, p.title, p.status, p.version,
              p.effort_lo_days, p.effort_hi_days, p.cost_low, p.cost_high,
              p.cost_currency, p.confidence, p.created_at
       from public.project_option p
       join public.hypothesis h on h.id = p.hypothesis_id
       join public.company c on c.id = h.company_id
       ${conds.length > 0 ? `where ${conds.join(" and ")}` : ""}
       order by p.created_at desc limit $${params.length}`,
      params,
    );
    return NextResponse.json({ proposals: r.rows }, { status: 200 });
  } catch {
    return NextResponse.json(
      { code: "internal", message: "internal error" },
      { status: 500 },
    );
  }
}
