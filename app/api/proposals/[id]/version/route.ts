import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { createVersion } from "@/lib/proposal/proposals";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/**
 * POST /api/proposals/[id]/version — draft a new version superseding this
 * one. Body: changed content fields (same validation as creation). History
 * is never rewritten; the prior version becomes superseded with audit.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
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
  const pick = <T>(v: unknown): T | undefined =>
    v === undefined ? undefined : (v as T);
  try {
    const result = await createVersion(getPool(), id, (auth.email ?? actorOf(body)), {
      title: str(body["title"]),
      scopeIn: pick<string | null>(body["scopeIn"]) ?? undefined,
      scopeOut: pick<string | null>(body["scopeOut"]) ?? undefined,
      milestones: pick<string | null>(body["milestones"]) ?? undefined,
      feasibility: body["feasibility"] as "high" | "medium" | "low" | "unknown" | undefined,
      capabilityFit: pick<string | null>(body["capabilityFit"]) ?? undefined,
      assumptions: str(body["assumptions"]),
      impactNote: pick<string | null>(body["impactNote"]) ?? undefined,
      dependencies: pick<string | null>(body["dependencies"]) ?? undefined,
      validationQuestions: pick<string | null>(body["validationQuestions"]) ?? undefined,
      capabilityKeys: Array.isArray(body["capabilityKeys"])
        ? (body["capabilityKeys"] as unknown[]).filter((k): k is string => typeof k === "string")
        : undefined,
      items: Array.isArray(body["items"])
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
        : undefined,
      contingencyPct:
        typeof body["contingencyPct"] === "number" ? body["contingencyPct"] : undefined,
      unknowns: Array.isArray(body["unknowns"])
        ? (body["unknowns"] as unknown[]).filter((u): u is string => typeof u === "string")
        : undefined,
      costLow: typeof body["costLow"] === "number" ? body["costLow"] : undefined,
      costHigh: typeof body["costHigh"] === "number" ? body["costHigh"] : undefined,
      costCurrency: str(body["costCurrency"]),
      pricingModel: (body["pricingModel"] ?? undefined) as
        | "fixed_scope"
        | "time_and_materials"
        | "not_defined"
        | undefined,
      taxNote: pick<string | null>(body["taxNote"]) ?? undefined,
      timelineLoWeeks: typeof body["timelineLoWeeks"] === "number" ? body["timelineLoWeeks"] : undefined,
      timelineHiWeeks: typeof body["timelineHiWeeks"] === "number" ? body["timelineHiWeeks"] : undefined,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
