import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi } from "@/lib/auth/guard";
import { parseAgencyFilters, fetchAgencyRowsForExport, MAX_PER_PAGE } from "@/lib/dashboard/agency-query";
import { toCsv, AGENCY_EXPORT_COLUMNS } from "@/lib/export/csv";

/**
 * GET /api/export — authenticated export of the agency directory.
 *
 * GET /api/export?q=&country=&agencyType=&status=&canonicalOnly=&sort=&dir=
 *                 &format=csv|json
 *
 * ACCEPTANCE: every filter parameter is parsed by the SAME parser the
 * /agencies page uses and resolved through the SAME SQL builder, so an export
 * can never contain a different dataset than the screen the operator was
 * looking at. No caller-supplied value is concatenated into SQL.
 *
 * SCOPE: company fields + evidence volume/attribution roll-up only. Claim
 * text, snapshots, payloads and any credentials are NOT exported; there is no
 * secret or personal-contact data in these columns.
 *
 * LIMITS: hard-capped at MAX_PER_PAGE rows. When the cap trims the result the
 * response sets `X-Export-Capped: true` and includes `truncated` in JSON —
 * truncation is reported, never silent.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireOperatorApi(req);
  if (!auth.ok) return auth.response!;

  const url = new URL(req.url);
  const format = (url.searchParams.get("format") ?? "csv").toLowerCase();
  if (format !== "csv" && format !== "json") {
    return NextResponse.json(
      { code: "bad_format", message: "format must be csv or json" },
      { status: 422 },
    );
  }
  const filters = parseAgencyFilters(url.searchParams);

  try {
    const { rows, capped } = await fetchAgencyRowsForExport(getPool(), filters, MAX_PER_PAGE);
    const headers = AGENCY_EXPORT_COLUMNS.map((c) => c.key);
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === "json") {
      return NextResponse.json(
        {
          generated_at: new Date().toISOString(),
          filters: {
            q: filters.q,
            country: filters.country,
            agency_type: filters.agencyType,
            status: filters.status,
            canonical_only: filters.canonicalOnly,
            sort: filters.sort,
            dir: filters.dir,
          },
          row_count: rows.length,
          truncated: capped,
          // Column semantics travel with the data so a consumer cannot guess.
          columns: AGENCY_EXPORT_COLUMNS.map((c) => ({
            key: c.key,
            semantics: c.semantics,
          })),
          rows: rows.map((r) =>
            Object.fromEntries(AGENCY_EXPORT_COLUMNS.map((c) => [c.key, c.value(r)])),
          ),
        },
        { status: 200, headers: { "X-Export-Capped": capped ? "true" : "false" } },
      );
    }

    const csv = toCsv(
      headers,
      rows.map((r) => AGENCY_EXPORT_COLUMNS.map((c) => c.value(r))),
    );
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="agencies-${stamp}.csv"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "X-Export-Capped": capped ? "true" : "false",
      },
    });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}