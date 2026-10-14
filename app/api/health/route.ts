import { NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";

/**
 * GET /api/health — liveness + PostgreSQL readiness (PUBLIC by design).
 *
 * Infrastructure signal only: `{ status, db: { ok, latencyMs } }`. It carries
 * NO company records, credentials, counts, stack traces, environment values,
 * or session details, so unauthenticated monitoring can poll it. Anything
 * private stays behind requireOperatorApi on the other /api/* routes.
 */
export async function GET(): Promise<NextResponse> {
  const t0 = Date.now();
  try {
    const pool = getPool();
    await pool.query("select 1");
    return NextResponse.json(
      { status: "ok", db: { ok: true, latencyMs: Date.now() - t0 } },
      { status: 200 },
    );
  } catch {
    return NextResponse.json(
      { status: "unhealthy", db: { ok: false, latencyMs: Date.now() - t0 } },
      { status: 503 },
    );
  }
}
