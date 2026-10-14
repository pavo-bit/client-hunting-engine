import { NextResponse } from "next/server";
import { getPool } from "@/lib/intake/db";
import { logDecision, reqIdOf } from "@/lib/ops/http-log";
import { getAuthConfig } from "@/lib/auth/config";
import { clientIp } from "@/lib/auth/http";
import { getDummyHash, isPlausibleEmail, normalizeEmail, verifyPassword } from "@/lib/auth/password";
import {
  checkRateLimit,
  rateLimitKey,
  recordFailure,
  recordSuccess,
} from "@/lib/auth/ratelimit";
import { createSession, SESSION_COOKIE } from "@/lib/auth/sessions";
import { safeNextPath } from "@/lib/auth/guard";

/**
 * POST /api/auth/login — operator login (PUBLIC endpoint, rate-limited).
 * Body: { email, password, next? }.
 *
 * Responses are deliberately generic: unknown email, wrong password, and
 * unconfigured auth are indistinguishable except by status (401 vs 503), and
 * no response ever carries secrets, hashes, or user-enumeration detail.
 * Success sets the HttpOnly session cookie and rotates the session (prior
 * sessions for the operator are revoked inside createSession).
 */
export async function POST(req: Request): Promise<NextResponse> {
  const t0 = Date.now();
  const reqId = reqIdOf(req);
  const done = (outcome: string) => {
    try {
      logDecision({ event: "login", outcome, route: "/api/auth/login", reqId, ms: Date.now() - t0 });
    } catch {
      /* logging never breaks login */
    }
  };
  const cfg = getAuthConfig();
  if (cfg.devOpen) {
    // Isolated dev/test path only; never honored in production (see config).
    return NextResponse.json({ ok: true, next: "/" }, { status: 200 });
  }
  if (!cfg.configured) {
    done("unavailable");
    return NextResponse.json(
      { code: "auth_unavailable", message: "Operator authentication is not configured." },
      { status: 503 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    done("bad_request");
    return NextResponse.json(
      { code: "bad_request", message: "Enter a valid email and password." },
      { status: 400 },
    );
  }

  const email = normalizeEmail(body["email"]);
  const password = typeof body["password"] === "string" ? body["password"] : "";
  if (!isPlausibleEmail(email) || password.length === 0 || password.length > 1024) {
    done("bad_request");
    return NextResponse.json(
      { code: "bad_request", message: "Enter a valid email and password." },
      { status: 400 },
    );
  }

  const key = rateLimitKey(clientIp((n) => req.headers.get(n)), email);
  const rateCfg = {
    maxAttempts: cfg.loginMaxAttempts,
    windowSec: cfg.loginWindowSec,
    lockSec: cfg.loginLockSec,
  };
  const locked = checkRateLimit(key, rateCfg);
  if (locked !== null) {
    done("locked");
    return NextResponse.json(
      { code: "rate_limited", message: "Too many attempts. Try again later." },
      { status: 429 },
    );
  }

  // Timing parity: unknown emails still burn a full scrypt verification.
  const known = email === cfg.operatorEmail;
  const ok = known
    ? await verifyPassword(password, cfg.passwordHash)
    : await verifyPassword(password, await getDummyHash());

  if (!ok) {
    recordFailure(key, rateCfg);
    // Audit the failure (never the password, never the hash). Lockout
    // rejections above are deliberately NOT audited: the lockout itself is
    // the control, and auditing every throttled hit would let an attacker
    // bloat audit_log one row per request.
    try {
      await getPool().query(
        `insert into public.audit_log (entity_type, entity_id, actor, transition_from, transition_to, reason)
         values ('auth', $1, $1, null, 'login_failed', 'invalid credentials')`,
        [email.slice(0, 300)],
      );
    } catch {
      /* audit is best-effort; the 401 stands regardless */
    }
    done("failed");
    return NextResponse.json(
      { code: "invalid_credentials", message: "Invalid email or password." },
      { status: 401 },
    );
  }
  recordSuccess(key);

  const { rawToken } = await createSession(getPool(), cfg, cfg.operatorEmail);
  const secure = cfg.cookieSecureDefault || (req.headers.get("x-forwarded-proto") ?? "") === "https";
  const res = NextResponse.json(
    { ok: true, next: safeNextPath(body["next"]) },
    { status: 200 },
  );
  res.cookies.set(SESSION_COOKIE, rawToken, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: cfg.sessionTtlSec,
  });
  done("success");
  return res;
}
