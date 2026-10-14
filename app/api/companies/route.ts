import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { createCompany } from "@/lib/intake/import";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * GET /api/companies — read-only agency directory listing (dashboard support).
 * Query: ?q= substring filter on name/domain (parameterized) , ?limit= 1..500
 * (default 100). Returns company fields only — no secrets, no PII beyond
 * stored business records. Additive endpoint; POST contract unchanged.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireOperatorApi(req);
  if (!auth.ok) return auth.response!;
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const limit = Math.min(
    Math.max(Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 1),
    500,
  );
  try {
    const pool = getPool();
    const params: unknown[] = [];
    let where = "";
    if (q !== "") {
      params.push(`%${q}%`);
      where = "where name ilike $1 or coalesce(domain_norm, '') ilike $1";
    }
    params.push(limit);
    const r = await pool.query(
      `select id, name, domain_norm, registry_id, agency_type, country,
              country_code, region, website_url, discovery_status, created_at
       from public.company ${where}
       order by created_at desc limit $${params.length}`,
      params,
    );
    return NextResponse.json({ companies: r.rows }, { status: 200 });
  } catch {
    return NextResponse.json(
      { code: "internal", message: "internal error" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/companies — manual agency creation.
 * Body: { name, domain?, registryId?, agencyType, country, countryCode?,
 *         region?, websiteUrl?, actor? }. Server validates + normalizes;
 * client-supplied IDs/statuses are not accepted (no such fields exist).
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
  const input = {
    name: (body["name"] as string) ?? "",
    domain: (body["domain"] as string) ?? "",
    registryId: (body["registryId"] as string) ?? "",
    registryType: (body["registryType"] as string) ?? "",
    agencyType: (body["agencyType"] as string) ?? "",
    country: (body["country"] as string) ?? "",
    countryCode: (body["countryCode"] as string) ?? "",
    region: (body["region"] as string) ?? "",
    websiteUrl: (body["websiteUrl"] as string) ?? "",
  };
  try {
    const r = await createCompany(getPool(), input, (auth.email ?? actorOf(body)));
    return NextResponse.json({ companyId: r.companyId }, { status: 201 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
