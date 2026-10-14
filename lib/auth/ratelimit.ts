// AUTH-001: login rate limiting (server-only).
//
// In-memory per-key attempt ledger. This is a single-operator, local-only
// tool running as one Node process, so process memory is proportionate - no
// Redis, no extra infrastructure (per project constraints). Limits: after
// `maxAttempts` failures inside `windowSec`, further attempts for that key are
// rejected for `lockSec`. Success clears the key. `_resetRateLimit` exists
// solely for deterministic tests.

export interface RateLimitConfig {
  maxAttempts: number;
  windowSec: number;
  lockSec: number;
}

interface Entry {
  failures: number[];
  lockedUntil: number;
}

const buckets = new Map<string, Entry>();

export function rateLimitKey(ip: string, email: string): string {
  return `${ip.trim().slice(0, 80).toLowerCase()}|${email.trim().slice(0, 320).toLowerCase()}`;
}

/** Returns null when the attempt may proceed, or seconds remaining when locked. */
export function checkRateLimit(key: string, cfg: RateLimitConfig, nowMs = Date.now()): number | null {
  const e = buckets.get(key);
  if (!e) return null;
  if (e.lockedUntil > nowMs) return Math.ceil((e.lockedUntil - nowMs) / 1000);
  return null;
}

export function recordFailure(key: string, cfg: RateLimitConfig, nowMs = Date.now()): void {
  let e = buckets.get(key);
  if (!e) {
    e = { failures: [], lockedUntil: 0 };
    buckets.set(key, e);
  }
  e.failures = e.failures.filter((t) => nowMs - t < cfg.windowSec * 1000);
  e.failures.push(nowMs);
  if (e.failures.length >= cfg.maxAttempts) {
    e.lockedUntil = nowMs + cfg.lockSec * 1000;
    e.failures = [];
  }
  // Bound memory: drop idle buckets opportunistically.
  if (buckets.size > 10000) {
    for (const [k, v] of buckets) {
      if (v.lockedUntil <= nowMs && v.failures.length === 0) buckets.delete(k);
      if (buckets.size <= 5000) break;
    }
  }
}

export function recordSuccess(key: string): void {
  buckets.delete(key);
}

export function _resetRateLimit(): void {
  buckets.clear();
}
