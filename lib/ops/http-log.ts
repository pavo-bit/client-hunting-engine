// MILESTONE 3: status-accurate security logging (server-only).
//
// Edge middleware (middleware.ts) cannot observe response statuses, so the
// decisions that matter most log themselves here: authentication denials and
// login outcomes. Payload shape is fixed and narrow — event, outcome, route,
// request id, latency — and NEVER includes emails, passwords, hashes,
// tokens, cookies, headers, bodies, or query strings. Redaction tests assert
// the absence of those fields by scanning this module's source.

export interface DecisionLog {
  event: "auth" | "login";
  outcome: string;
  route: string;
  reqId: string;
  ms: number;
}

export function reqIdOf(req: Request): string {
  const v = (req.headers.get("x-request-id") ?? "").trim().slice(0, 80);
  if (/^[0-9a-fA-F-]{8,80}$/.test(v)) return v;
  return "none";
}

export function logDecision(d: DecisionLog): void {
  console.log(JSON.stringify({ ...d, ms: Math.max(0, Math.min(d.ms, 3600000)) }));
}
