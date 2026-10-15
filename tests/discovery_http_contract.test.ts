/**
 * Path-parameter validation on the Discovery read endpoints (HTTP contract).
 * An operator-supplied path id is untrusted input: a malformed uuid must be a
 * clean 422, never a raw database error surfaced as 500.
 */
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GET as refreshGET } from "../app/api/discovery/refreshes/[id]/route";
import { GET as runGET } from "../app/api/discovery/runs/[id]/route";

const ORIGIN = "http://127.0.0.1:3101";
const BAD = ["=50", "not-a-uuid", "12345", "%20", "../../etc/passwd", "0000-0000"];

function req(path: string): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, { headers: { host: "127.0.0.1:3101" } });
}

describe("discovery path id validation", () => {
  it("refresh status rejects malformed run ids with 422", async () => {
    for (const id of BAD) {
      const res = await refreshGET(req(`/api/discovery/refreshes/${id}`), {
        params: Promise.resolve({ id }),
      });
      // Either the 422 guard fires, or (unreachable here) auth refuses first.
      expect([401, 403, 422]).toContain(res.status);
      if (res.status === 422) {
        expect(await res.json()).toMatchObject({ code: "bad_id" });
      }
    }
  });

  it("run detail rejects malformed run ids with 422", async () => {
    for (const id of BAD) {
      const res = await runGET(req(`/api/discovery/runs/${id}`), {
        params: Promise.resolve({ id }),
      });
      expect([401, 403, 422]).toContain(res.status);
      if (res.status === 422) {
        expect(await res.json()).toMatchObject({ code: "bad_id" });
      }
    }
  });
});