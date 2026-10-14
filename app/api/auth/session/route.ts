import { NextResponse } from "next/server";
import { requireOperatorApi } from "@/lib/auth/guard";

/**
 * GET /api/auth/session — authenticated-operator state for the UI shell.
 * PUBLIC endpoint: anonymous callers get { authenticated: false } (no private
 * data, no secrets). Authenticated callers get their operator email so the
 * shell can show who is signed in.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const auth = await requireOperatorApi(req);
  if (!auth.ok) return NextResponse.json({ authenticated: false }, { status: 200 });
  return NextResponse.json(
    { authenticated: true, email: auth.email, viaServiceToken: auth.viaServiceToken },
    { status: 200 },
  );
}
