// Shared API error mapping (T-003). IntakeError carries its HTTP status;
// anything else is a 500 with no internal detail leaked.

import { NextResponse } from "next/server";
import type { IntakeError } from "@/lib/intake/import";

export function intakeErrorResponse(e: unknown): NextResponse {
  const ie = e as Partial<IntakeError>;
  if (ie && typeof ie.status === "number" && typeof ie.code === "string") {
    let details: unknown = ie.message;
    if (ie.code === "validation_failed") {
      try {
        details = JSON.parse(ie.message as string);
      } catch {
        /* keep raw message */
      }
    }
    return NextResponse.json(
      { code: ie.code, message: ie.message, errors: details },
      { status: ie.status },
    );
  }
  return NextResponse.json(
    { code: "internal", message: "internal error" },
    { status: 500 },
  );
}

export function actorOf(body: Record<string, unknown>): string {
  const a = body["actor"];
  if (typeof a === "string" && a.trim().length > 0) return a.trim().slice(0, 200);
  return "operator";
}

/**
 * Legacy bearer-token check (AUTH-001: CLOSED by default).
 *
 * Previously an empty configured token meant "local-dev open mode" (every
 * request passed). That bypass is removed: an empty/missing token now grants
 * NOTHING, and only an exact `Authorization: Bearer <token>` match against a
 * configured non-empty token passes. The isolated dev/test bypass, where one
 * is needed at all, lives explicitly in lib/auth/guard.ts (AUTH_DEV_OPEN,
 * never honored in production).
 *
 * New code must use requireOperatorApi() (session-first, bearer as explicit
 * service credential). This function remains only as the pure, unit-testable
 * bearer comparison. Pure function over a header getter.
 */
export function checkOperatorToken(
  getHeader: (name: string) => string | null,
  configured = (process.env.OPERATOR_API_TOKEN ?? "").trim(),
): boolean {
  if (configured === "") return false;
  return getHeader("authorization") === `Bearer ${configured}`;
}
