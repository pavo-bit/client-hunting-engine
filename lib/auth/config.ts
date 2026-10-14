// AUTH-001: authentication configuration. Single source of truth for every
// guard, route, and test. Reads env with safe defaults; missing secrets fail
// CLOSED (configured=false), never open. This module holds no secrets itself.

export interface AuthConfig {
  /** True only when a provisioned operator credential exists. */
  configured: boolean;
  operatorEmail: string;
  passwordHash: string;
  /** Sliding session lifetime, seconds. */
  sessionTtlSec: number;
  /** Absolute cap from session creation, seconds. */
  sessionMaxSec: number;
  loginMaxAttempts: number;
  loginWindowSec: number;
  loginLockSec: number;
  /** Explicit, isolated dev/test open mode. NEVER honored in production. */
  devOpen: boolean;
  isProduction: boolean;
  /** Legacy bearer token; empty means "no bearer auth", never "open". */
  serviceToken: string;
  /** Cookie Secure flag: on in production or over https. */
  cookieSecureDefault: boolean;
}

function num(raw: string | undefined, fallback: number, min: number, max: number): number {
  const v = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(Math.max(Math.trunc(v), min), max);
}

/** Post-expansion shape of a provisioned scrypt hash. Anything else (empty,
 *  truncated, or mangled by .env `$` expansion) fails closed. */
const HASH_SHAPE = /^scrypt\$\d+\$\d+\$\d+\$.+\$.+$/;

export function getAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const isProduction = env.NODE_ENV === "production";
  const operatorEmail = (env.OPERATOR_EMAIL ?? "").trim().toLowerCase().slice(0, 320);
  const passwordHash = (env.OPERATOR_PASSWORD_HASH ?? "").trim();
  // Explicit opt-in only; production always ignores it (fail closed).
  const devOpen = !isProduction && (env.AUTH_DEV_OPEN ?? "") === "1";
  const serviceToken = (env.OPERATOR_API_TOKEN ?? "").trim();
  return {
    configured: operatorEmail.length >= 3 && HASH_SHAPE.test(passwordHash),
    operatorEmail,
    passwordHash,
    sessionTtlSec: num(env.AUTH_SESSION_TTL_SEC, 12 * 3600, 300, 7 * 24 * 3600),
    sessionMaxSec: num(env.AUTH_SESSION_MAX_SEC, 24 * 3600, 900, 30 * 24 * 3600),
    loginMaxAttempts: num(env.AUTH_LOGIN_MAX_ATTEMPTS, 5, 1, 100),
    loginWindowSec: num(env.AUTH_LOGIN_WINDOW_SEC, 600, 60, 24 * 3600),
    loginLockSec: num(env.AUTH_LOGIN_LOCK_SEC, 600, 60, 24 * 3600),
    devOpen,
    isProduction,
    serviceToken,
    cookieSecureDefault: isProduction || (env.AUTH_COOKIE_SECURE ?? "") === "1",
  };
}

/**
 * Fail-closed gate for production boot: throws when authentication cannot
 * function (no provisioned credential AND no explicit service token) so a
 * misconfigured production deployment refuses to serve rather than serving
 * open or serving a login that can never succeed.
 */
export function assertAuthAvailable(cfg: AuthConfig = getAuthConfig()): void {
  if (!cfg.isProduction) return;
  if (!cfg.configured && cfg.serviceToken === "") {
    throw new Error(
      "auth_not_configured: production requires OPERATOR_EMAIL + OPERATOR_PASSWORD_HASH (see scripts/operator.mjs) or an explicit OPERATOR_API_TOKEN service credential",
    );
  }
}
