import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { previewImport } from "@/lib/intake/import";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/imports — upload CSV text, validate, stage, return preview.
 * Body: { filename, csv, actor? }. Server enforces type/size/row limits
 * (D-007: 5000 rows, CSV only); nothing is committed to `company` here.
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
  const filename = typeof body["filename"] === "string" ? body["filename"] : "";
  const csv = typeof body["csv"] === "string" ? body["csv"] : "";
  if (filename.trim() === "")
    return NextResponse.json(
      { code: "missing_filename", message: "filename is required" },
      { status: 422 },
    );
  if (!filename.toLowerCase().endsWith(".csv"))
    return NextResponse.json(
      { code: "not_csv", message: "CSV only; no XLSX (D-007)" },
      { status: 422 },
    );
  try {
    const preview = await previewImport(getPool(), {
      filename,
      csvText: csv,
      actor: (auth.email ?? actorOf(body)),
    });
    return NextResponse.json(preview, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
