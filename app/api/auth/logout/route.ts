import { NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { getAuthConfig } from "@/lib/auth/config";
import { revokeSession, SESSION_COOKIE } from "@/lib/auth/sessions";

/**
 * POST /api/auth/logout — revokes the server-side session, then clears the
 * cookie. Always succeeds (idempotent): an absent or unknown session still
 * returns ok with the cookie cleared, so logout can never leak whether a
 * session existed.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const cfg = getAuthConfig();
  const cookieHeader = req.headers.get("cookie") ?? "";
  const raw = cookieHeader
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1)
    ?.trim();
  if (raw) {
    try {
      await revokeSession(getPool(), decodeURIComponent(raw));
    } catch {
      /* revocation is best-effort; the cookie is cleared regardless */
    }
  }
  const secure = cfg.cookieSecureDefault || (req.headers.get("x-forwarded-proto") ?? "") === "https";
  const res = NextResponse.json({ ok: true }, { status: 200 });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0,
  });
  return res;
}
