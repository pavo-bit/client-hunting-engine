// Guarded outbound fetch for live adapters (T-006). No caller reaches the
// network without: fixed allowlisted base URL (per adapter), fetch-guard
// validation on every hop, manual redirect handling (https + same host only,
// max 2), abort support. Response BODIES never enter diagnostics (secret
// redaction by construction). Injectable fetchImpl keeps tests offline.

import { validateFetchUrl } from "./fetch-guard";

export type FetchImpl = typeof fetch;

export interface FetchOk {
  ok: true;
  status: number;
  json: unknown;
  url: string;
}

export interface FetchFail {
  ok: false;
  kind: "network" | "cancelled" | "redirect_blocked" | "http";
  status?: number;
  /** Safe summary only: status + reason. Never body content. */
  message: string;
}

const MAX_REDIRECTS = 2;

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase();
  } catch {
    return false;
  }
}

export async function fetchJson(
  url: string,
  opts: { signal?: AbortSignal; fetchImpl?: FetchImpl } = {},
): Promise<FetchOk | FetchFail> {
  const impl = opts.fetchImpl ?? fetch;
  const gate = validateFetchUrl(url);
  if (!gate.ok)
    return { ok: false, kind: "redirect_blocked", message: `blocked destination: ${gate.reason}` };

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (opts.signal?.aborted)
      return { ok: false, kind: "cancelled", message: "cancelled before request" };
    let res: Response;
    try {
      res = await impl(current, { signal: opts.signal, redirect: "manual" });
    } catch (e: unknown) {
      if (opts.signal?.aborted)
        return { ok: false, kind: "cancelled", message: "cancelled during request" };
      return { ok: false, kind: "network", message: "network failure reaching source" };
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
      return { ok: false, kind: "http", status: res.status, message: `source error ${res.status}` };
    }
    try {
      const json: unknown = await res.json();
      return { ok: true, status: res.status, json, url: current };
    } catch {
      return { ok: false, kind: "http", status: res.status, message: "unparseable response body" };
    }
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
