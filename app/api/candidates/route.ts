import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { getCandidateQueue } from "@/lib/resolve/engine";
import { requireOperatorApi } from "@/lib/auth/guard";

/** GET /api/candidates?status=pending — review queue (canonical pairs only). */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireOperatorApi(req);
  if (!auth.ok) return auth.response!;
  const status = new URL(req.url).searchParams.get("status") ?? "pending";
  if (!["pending", "accepted", "rejected", "deferred"].includes(status))
    return NextResponse.json(
      { code: "bad_status", message: "unknown candidate status" },
      { status: 422 },
    );
  try {
    const rows = await getCandidateQueue(getPool(), status);
    return NextResponse.json({ candidates: rows }, { status: 200 });
  } catch {
    return NextResponse.json(
      { code: "internal", message: "internal error" },
      { status: 500 },
    );
  }
}
