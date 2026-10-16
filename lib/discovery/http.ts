// Guarded outbound fetch for live adapters (T-006, hardened in Phase 2). No
// caller reaches the network without: fixed allowlisted base URL (per
// adapter), fetch-guard validation on every hop, manual redirect handling
// (https + same host only, max 2), abort support, a per-request timeout, and
// a response-body cap enforced WHILE READING. Response BODIES never enter
// diagnostics (secret redaction by construction). Injectable fetchImpl keeps
// tests offline.
//
// PHASE 2 HARDENING (gaps found by inspection, all covered by tests):
//   1. per-request timeout (previously only the CALLER's signal bounded a
//      request, so a hung socket could outlive adapter-level budgets);
//   2. strict maximum body size enforced during streaming, with the stream
//      cancelled on breach (previously `res.json()` buffered an unbounded
//      body before anything was checked);
//   3. content-type validation before parsing (prevents an HTML error/login
//      page being parsed as source data);
//   4. `Retry-After` surfaced for 429/503 so adapters back off correctly
//      instead of guessing.
//
// COMPATIBILITY NOTE: when a response carries NO content-type header at all
// (some minimal fetch implementations and the existing GLEIF tests omit it),
// the header check is skipped and correctness falls to JSON parsing plus the
// adapter's own response-shape validation. A present-but-wrong content-type
// is always refused.

import { validateFetchUrl } from "./fetch-guard";

export type FetchImpl = typeof fetch;

export interface FetchOk {
  ok: true;
  status: number;
  json: unknown;
  url: string;
}

export type FetchFailKind =
  | "network"
  | "cancelled"
  | "redirect_blocked"
  | "http"
  | "too_large"
  | "bad_content_type";

export interface FetchFail {
  ok: false;
  kind: FetchFailKind;
  status?: number;
  /** Safe summary only: status + reason. Never body content. */
  message: string;
  /**
   * Server-requested retry delay (seconds) parsed from `Retry-After` on
   * 429/503. Absent when the header is missing or unparseable — adapters must
   * fall back to their own bounded backoff, never to an unbounded sleep.
   */
  retryAfterSec?: number;
}

const MAX_REDIRECTS = 2;
/** Default per-request ceiling. Adapters may lower it; raising needs review. */
const DEFAULT_TIMEOUT_MS = 15_000;
/** Default body ceiling (2 MB) — generous for a small JSON document. */
const DEFAULT_MAX_BYTES = 2_000_000;
/** Hard floor for the body cap so a caller cannot disable the control. */
const MIN_MAX_BYTES = 1024;

const JSON_CONTENT_TYPE = /^(application\/json|application\/[^;\s]+\+json|text\/json)\b/i;

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase();
  } catch {
    return false;
  }
}

/** Parse `Retry-After` as delta-seconds or an HTTP-date. Never throws. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const raw = header.trim();
  if (/^\d+$/.test(raw)) {
    const s = Number.parseInt(raw, 10);
    return Number.isFinite(s) ? Math.min(s, 300) : undefined;
  }
  // HTTP-date only. Date.parse is dangerously permissive (it happily reads
  // bare numbers and odd fragments as dates), so the shape is checked first —
  // anything else is treated as unparseable rather than guessed.
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),/.test(raw)) return undefined;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  const delta = Math.ceil((at - now) / 1000);
  return delta < 0 ? 0 : Math.min(delta, 300);
}

/**
 * Read and parse a JSON body under a hard byte ceiling. The ceiling is
 * checked per chunk and the stream is CANCELLED on breach, so an oversized
 * or endless response is never fully buffered.
 */
async function readJsonCapped(
  res: Response,
  maxBytes: number,
): Promise<{ ok: true; json: unknown } | { ok: false; message: string }> {
  const ct = (res.headers.get("content-type") ?? "").trim();
  const base = ct.split(";")[0].trim();
  if (base !== "" && !JSON_CONTENT_TYPE.test(base)) {
    return { ok: false, message: `unexpected content-type: ${base}` };
  }
  const parse = (text: string): { ok: true; json: unknown } | { ok: false; message: string } => {
    try {
      return { ok: true, json: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, message: "unparseable response body" };
    }
  };

  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    // No streaming body available: text() is still bounded by the cap check,
    // but only AFTER buffering — a documented weaker path.
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes)
      return { ok: false, message: `response body exceeds ${maxBytes} byte limit` };
    return parse(text);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return {
        ok: false,
        message: `response body exceeds ${maxBytes} byte limit (aborted while reading)`,
      };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return parse(new TextDecoder().decode(buf));
}

export async function fetchJson(
  url: string,
  opts: { signal?: AbortSignal; fetchImpl?: FetchImpl; timeoutMs?: number; maxBytes?: number } = {},
): Promise<FetchOk | FetchFail> {
  const impl = opts.fetchImpl ?? fetch;
  const timeoutMs = Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1);
  const maxBytes = Math.max(opts.maxBytes ?? DEFAULT_MAX_BYTES, MIN_MAX_BYTES);
  const gate = validateFetchUrl(url);
  if (!gate.ok)
    return { ok: false, kind: "redirect_blocked", message: `blocked destination: ${gate.reason}` };

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (opts.signal?.aborted)
      return { ok: false, kind: "cancelled", message: "cancelled before request" };

    // Per-request timeout, chained to the caller's signal so either can stop
    // the request; `timedOut` distinguishes the two for the caller.
    const ctrl = new AbortController();
    let timedOut = false;
    const onOuter = () => ctrl.abort(new Error("cancelled"));
    opts.signal?.addEventListener("abort", onOuter, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort(new Error("request timeout"));
    }, timeoutMs);

    let res: Response;
    try {
      res = await impl(current, { signal: ctrl.signal, redirect: "manual" });
    } catch {
      if (opts.signal?.aborted)
        return { ok: false, kind: "cancelled", message: "cancelled during request" };
      if (timedOut)
        return { ok: false, kind: "network", message: `request exceeded ${timeoutMs}ms` };
      return { ok: false, kind: "network", message: "network failure reaching source" };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuter);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) return { ok: false, kind: "http", status: res.status, message: "redirect without location" };
      let next: string;
      try {
        next = new URL(loc, current).toString();
      } catch {
        return { ok: false, kind: "redirect_blocked", message: "unparseable redirect target" };
      }
      const check = validateFetchUrl(next);
      if (!check.ok || !next.startsWith("https://") || !sameHost(next, current))
        return {
          ok: false,
          kind: "redirect_blocked",
          message: `redirect blocked: ${check.ok ? "cross-host or non-https" : check.reason}`,
        };
      if (hop === MAX_REDIRECTS)
        return { ok: false, kind: "redirect_blocked", message: "too many redirects" };
      current = next;
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      const retryAfterSec =
        res.status === 429 || res.status === 503
          ? parseRetryAfter(res.headers.get("retry-after"))
          : undefined;
      return {
        ok: false,
        kind: "http",
        status: res.status,
        message: `source error ${res.status}`,
        ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
      };
    }

    let read: { ok: true; json: unknown } | { ok: false; message: string };
    try {
      read = await readJsonCapped(res, maxBytes);
    } catch {
      if (opts.signal?.aborted)
        return { ok: false, kind: "cancelled", message: "cancelled during read" };
      return { ok: false, kind: "network", message: "response body read failed" };
    }
    if (!read.ok) {
      if (read.message.includes("content-type"))
        return { ok: false, kind: "bad_content_type", status: res.status, message: read.message };
      if (read.message.includes("byte limit"))
        return { ok: false, kind: "too_large", status: res.status, message: read.message };
      return { ok: false, kind: "http", status: res.status, message: read.message };
    }
    return { ok: true, status: res.status, json: read.json, url: current };
  }
  return { ok: false, kind: "redirect_blocked", message: "too many redirects" };
}

/** Abort-aware sleep for bounded backoff. Returns true when aborted. */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), Math.max(0, ms));
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve(true);
      },
      { once: true },
    );
  });
}