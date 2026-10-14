import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { attachEvidence, ingestObservation } from "@/lib/evidence/ingest";
import { actorOf, intakeErrorResponse } from "@/lib/intake/http";
import { requireOperatorApi, requireSameOrigin } from "@/lib/auth/guard";

/**
 * POST /api/evidence/ingest — record an observation (+ optional claim).
 * Body: { companyId, sourceKey, url, excerpt?, observedAt?, retentionClass?,
 *   actor?, claim?: { predicate?, text, initialStatus?, reliability,
 *   credibility, expiresAt? } }. Idempotent on content hash. Ingestion may
 * only assert observed/inferred/assumed — never verified or corroborated.
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
    const raw = (body["claim"] ?? null) as Record<string, unknown> | null;
    const result = await ingestObservation(
      getPool(),
      {
        companyId: typeof body["companyId"] === "string" ? body["companyId"] : "",
        sourceKey: typeof body["sourceKey"] === "string" ? body["sourceKey"] : "",
        url: typeof body["url"] === "string" ? body["url"] : "",
        excerpt: typeof body["excerpt"] === "string" ? body["excerpt"] : "",
        observedAt: typeof body["observedAt"] === "string" ? body["observedAt"] : undefined,
        retentionClass:
          typeof body["retentionClass"] === "string" ? body["retentionClass"] : undefined,
        actor: (auth.email ?? actorOf(body)),
      },
      raw
        ? {
            predicate: typeof raw["predicate"] === "string" ? raw["predicate"] : undefined,
            text: typeof raw["text"] === "string" ? raw["text"] : "",
            initialStatus:
              typeof raw["initialStatus"] === "string" ? raw["initialStatus"] : undefined,
            reliability: raw["reliability"] as "A" | "B" | "C" | "D",
            credibility: typeof raw["credibility"] === "number" ? raw["credibility"] : NaN,
            expiresAt: typeof raw["expiresAt"] === "string" ? raw["expiresAt"] : undefined,
          }
        : undefined,
    );
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    return intakeErrorResponse(e);
  }
}
