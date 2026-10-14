// AUTH-001: pure HTTP auth helpers (no Next.js imports - unit-testable).
//
// Central policy for API authentication:
//   1. Session cookie (opaque server-side session) - primary mechanism.
//   2. Explicit bearer service credential - ONLY when OPERATOR_API_TOKEN is
//      configured non-empty. An empty/missing token NEVER grants access.
// There is no "open mode" here; the isolated dev/test bypass lives in the
// guard layer (lib/auth/guard.ts) behind AUTH_DEV_OPEN, never in production.

import type { AuthConfig } from "./config";

/** Closed-by-default bearer check. Pure over a header getter (testable). */
export function checkServiceToken(
  getHeader: (name: string) => string | null,
  configured: string,
): boolean {
  if (configured === "") return false;
  const presented = getHeader("authorization");
  if (!presented) return false;
  return presented === `Bearer ${configured}`;
}

/**
 * CSRF guard for cookie-authenticated mutations: require a same-origin
 * Origin or Referer. Bearer-only callers (scripts, curl) carry no ambient
 * authority and skip this check. Returns true when the request may proceed.
 */
export function checkSameOrigin(
  getHeader: (name: string) => string | null,
  host: string | null,
): boolean {
  const origin = getHeader("origin");
  const referer = getHeader("referer");
  const want = (host ?? "").trim().toLowerCase();
  if (want === "") return false;
  const match = (v: string | null): boolean => {
    if (!v) return false;
    try {
      return new URL(v).host.toLowerCase() === want;
    } catch {
      return false;
    }
  };
  return match(origin) || match(referer);
}

/**
 * Open-redirect guard for post-login `?next=`. Only absolute paths on this
 * origin are allowed: single leading slash, no backslashes, no scheme,
 * no protocol-relative `//`, bounded length.
 */
export function safeNextPath(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  const v = raw.trim().slice(0, 500);
  if (!v.startsWith("/") || v.startsWith("//")) return "/";
  if (v.includes("\\") || /[\r\n]/.test(v)) return "/";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v.slice(1))) return "/";
  return v || "/";
}

/** Best-effort client key for rate limiting (local-only; may be absent). */
export function clientIp(getHeader: (name: string) => string | null): string {
  const fwd = getHeader("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0].trim();
    if (first) return first.slice(0, 80);
  }
  return "local";
}

export function authUnavailable(cfg: AuthConfig): boolean {
  return !cfg.configured;
}
