// AUTH-001: centralized server-side guards for pages and API routes.
//
// This is the ONLY authentication entry point for the application:
//   * Pages call `requireOperatorPage()` first; unauthenticated requests are
//     redirected to /login (preserving the target via a validated ?next=).
//   * API routes call `requireOperatorApi(req)`; unauthenticated requests get
//     HTTP 401 JSON, never private data, never stack traces.
//   * Mutations additionally call `requireSameOrigin(req, auth)` for CSRF.
// Session cookies are authoritative; bearer tokens are accepted only as an
// explicitly configured service credential. Client-supplied actor/email/role
// values are never trusted - use `session.operatorEmail` for attribution.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { logDecision, reqIdOf } from "@/lib/ops/http-log";
import { getAuthConfig, type AuthConfig } from "./config";
import { checkSameOrigin, checkServiceToken, clientIp, safeNextPath } from "./http";
import { SESSION_COOKIE, validateSession, type OperatorSession } from "./sessions";

export interface ApiAuth {
  ok: boolean;
  /** Present when authenticated (session email or service credential). */
  email: string | null;
  session: OperatorSession | null;
  /** True when authenticated via bearer service credential (skips CSRF). */
  viaServiceToken: boolean;
  response: NextResponse | null;
}

function unauthorized(message = "authentication required"): NextResponse {
  return NextResponse.json({ code: "unauthorized", message }, { status: 401 });
}

async function sessionFromCookie(cfg: AuthConfig): Promise<OperatorSession | null> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value ?? "";
  if (!raw) return null;
  return validateSession(getPool(), cfg, raw);
}

/**
 * Page guard. Returns the live session or redirects to /login.
 * Call as the first statement of every protected server page:
 * `await requireOperatorPage("/review")`.
 */
export async function requireOperatorPage(
  nextPath = "/",
  cfg: AuthConfig = getAuthConfig(),
): Promise<OperatorSession> {
  if (cfg.devOpen) {
    return { id: "dev-open", operatorEmail: cfg.operatorEmail || "operator", createdAt: "", expiresAt: "" };
  }
  const session = await sessionFromCookie(cfg);
  if (!session) {
    const next = safeNextPath(nextPath ?? "/");
    redirect(next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`);
  }
  return session;
}

/**
 * API guard. Session cookie first, then explicit bearer service credential.
 * Never 500s on auth failure; never leaks which credential was wrong.
 */
export async function requireOperatorApi(
  req: Request,
  cfg: AuthConfig = getAuthConfig(),
): Promise<ApiAuth> {
  const denied: ApiAuth = { ok: false, email: null, session: null, viaServiceToken: false, response: unauthorized() };
  if (cfg.devOpen) {
    return { ok: true, email: cfg.operatorEmail || "operator", session: null, viaServiceToken: false, response: null };
  }
  const getHeader = (n: string) => req.headers.get(n);
  const cookieHeader = getHeader("cookie") ?? "";
  const raw = cookieHeader
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1)
    ?.trim();
  if (raw) {
    const session = await validateSession(getPool(), cfg, decodeURIComponent(raw));
    if (session) {
      return { ok: true, email: session.operatorEmail, session, viaServiceToken: false, response: null };
    }
  }
  if (checkServiceToken(getHeader, cfg.serviceToken)) {
    return {
      ok: true,
      email: cfg.operatorEmail || "service",
      session: null,
      viaServiceToken: true,
      response: null,
    };
  }
  try {
    logDecision({ event: "auth", outcome: "denied", route: new URL(req.url).pathname.slice(0, 200), reqId: reqIdOf(req), ms: 0 });
  } catch {
    /* logging never breaks auth */
  }
  return denied;
}

/**
 * CSRF guard for state-changing API routes authenticated via cookie session.
 * Bearer-authenticated callers skip it (no ambient browser authority).
 */
export function requireSameOrigin(
  req: Request,
  auth: ApiAuth,
): NextResponse | null {
  if (!auth.ok || auth.viaServiceToken) return null;
  // The Host header is authoritative and always present behind a real server.
  // Deliberately NOT derived from req.url: the platform may normalize the URL
  // (observed: 127.0.0.1 rewritten to localhost), which would make the
  // comparison meaningless. A request with no usable Host is refused.
  const host = req.headers.get("host") ?? req.headers.get("x-forwarded-host");
  const getHeader = (n: string) => req.headers.get(n);
  if (!checkSameOrigin(getHeader, host)) {
    return NextResponse.json(
      { code: "forbidden", message: "origin check failed" },
      { status: 403 },
    );
  }
  return null;
}

export { clientIp, safeNextPath };
