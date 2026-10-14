// MILESTONE 3: request IDs + access log lines (Edge runtime).
//
// Assigns an `x-request-id` to every application request (pages + API,
// except framework internals), propagates it downstream and back on the
// response, and emits ONE JSON line per request to stdout.
//
// Redaction is by construction: this module reads ONLY method + pathname.
// It never touches headers, cookies, query strings, or bodies, so there is
// nothing secret to leak. It enforces no authentication (Edge has no
// database); authorization stays in lib/auth/guard.ts.
//
// Limitation, stated not hidden: Edge middleware cannot observe the final
// response status, so these lines carry no status code. Status-accurate
// logging lives where decisions are made — requireOperatorApi() logs its
// 401s and the login route logs every outcome (see lib/ops/http-log.ts).
// Error-rate aggregation therefore stays a manual log-inspection step
// (docs/RUNBOOK.md), not a metrics pipeline — proportionate for a
// local-only single-operator tool.

import { NextResponse, type NextRequest } from "next/server";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

export function middleware(req: NextRequest) {
  const reqId = crypto.randomUUID();
  let path = "/";
  try {
    path = new URL(req.url).pathname.slice(0, 500);
  } catch {
    /* keep default */
  }
  const headers = new Headers(req.headers);
  headers.set("x-request-id", reqId);
  console.log(JSON.stringify({ event: "request", reqId, method: req.method, path }));
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-request-id", reqId);
  return res;
}
