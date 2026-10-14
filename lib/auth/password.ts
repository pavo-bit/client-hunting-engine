// AUTH-001: password hashing + email normalization (server-only).
//
// Uses Node's built-in scrypt (no new dependencies). Parameters N=16384,
// r=8, p=1 with a 256-bit salt and 512-bit derived key are the conservative
// interactive-login choice: ~50-100ms per verification on commodity hardware,
// which also rate-shapes online guessing. Comparison is constant-time.
// This module must never be imported by client components.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number; maxmem?: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, derived) => {
      if (err) reject(err);
      else resolve(derived as Buffer);
    });
  });
}

const N = 16384;
const R = 8;
const P = 1;
const SALT_BYTES = 32;
const KEY_BYTES = 64;

/** Stored format: scrypt$N$r$p$base64(salt)$base64(key). Versioned prefix for future agility. */
export function formatHash(n: number, r: number, p: number, salt: Buffer, key: Buffer): string {
  return `scrypt$${n}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

function parseHash(stored: string): { n: number; r: number; p: number; salt: Buffer; key: Buffer } | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  // Refuse absurd parameters (DoS via crafted cost): only operator-chosen
  // values within a sane envelope are accepted.
  if (n < 1024 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 8) return null;
  try {
    const salt = Buffer.from(parts[4], "base64");
    const key = Buffer.from(parts[5], "base64");
    if (salt.length < 16 || salt.length > 128 || key.length < 32 || key.length > 128) return null;
    return { n, r, p, salt, key };
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, KEY_BYTES, { N, r: R, p: P });
  return formatHash(N, R, P, salt, key);
}

/**
 * Verify a password against a stored hash. Returns false (never throws) for
 * malformed stored hashes so a corrupt env value fails closed without detail.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  if (password.length === 0 || password.length > 1024) return false;
  const key = (await scryptAsync(password, parsed.salt, parsed.key.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: 64 * 1024 * 1024,
  })) as Buffer;
  if (key.length !== parsed.key.length) return false;
  return timingSafeEqual(key, parsed.key);
}

/**
 * Dummy verification for unknown emails: burns the same scrypt cost so
 * "unknown email" and "wrong password" are indistinguishable by timing.
 * The dummy hash is fixed and never matches anything real.
 */
let dummyHash: string | null = null;
export async function getDummyHash(): Promise<string> {
  if (!dummyHash) dummyHash = await hashPassword(randomBytes(32).toString("hex"));
  return dummyHash;
}

/** Normalize an email for comparison: trim + lowercase. Returns "" when unusable. */
export function normalizeEmail(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.trim().toLowerCase().slice(0, 320);
}

/** Conservative email shape check (server-side gate, not a full RFC parser). */
export function isPlausibleEmail(email: string): boolean {
  if (email.length < 3 || email.length > 320) return false;
  if (email.includes(" ") || email.includes("\n") || email.includes("\r")) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) return false;
  const domain = email.slice(at + 1);
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return false;
  if (email.length > 254) return false;
  return true;
}
