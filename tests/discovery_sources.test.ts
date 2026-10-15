/**
 * Source permission gate + crashed-run reaping policy (B-D5 / B-D6).
 *
 * STATUS: the pure-policy tests below have EXECUTED (no database needed). The
 * database-backed cases in tests/discovery_e2e.test.ts and
 * tests/discovery_reap_db.test.ts are WRITTEN BUT UNEXECUTED — Docker was down.
 */
import { describe, expect, it } from "vitest";
import { decideSource, runnableSources } from "../lib/discovery/sources";
import { parseStaleAfterMinutes } from "../lib/discovery/reap";
import { AgencyDirectoryFixture } from "../lib/discovery/fixtures/agency-directory";
import { GleifAdapter } from "../lib/discovery/adapters/gleif";

describe("decideSource: the registry is the only permission gate (§4F)", () => {
  it("permits a known, enabled source", () => {
    expect(decideSource({ key: "gleif-api", enabled: true }, "gleif-api")).toEqual({ ok: true });
  });

  it("refuses a disabled source (409 source_disabled) without inventing access", () => {
    const d = decideSource({ key: "linkedin", enabled: false }, "linkedin");
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("unreachable");
    expect(d.code).toBe("source_disabled");
    expect(d.message).toContain("disabled");
  });

  it("fails closed for unknown keys — absence is not permission", () => {
    for (const key of ["", "   ", "not-in-registry", "x".repeat(121)]) {
      const d = decideSource(undefined, key);
      expect(d.ok).toBe(false);
      if (d.ok) throw new Error("unreachable");
      expect(d.code).toBe("unknown_source");
    }
  });

  it("is order-insensitive on registry state, not on key identity", () => {
    expect(decideSource({ key: "a", enabled: false }, "b").ok).toBe(false);
    expect(decideSource({ key: "a", enabled: true }, "b").ok).toBe(false);
  });

  it("lists only currently runnable sources", () => {
    expect(
      runnableSources([
        { key: "gleif-api", enabled: true },
        { key: "linkedin", enabled: false },
        { key: "agency-directory", enabled: true },
      ]),
    ).toEqual(["gleif-api", "agency-directory"]);
  });

  it("both production and fixture adapters declare a registry key", () => {
    // No adapter may run undeclared: that is the gate's whole purpose.
    expect(new GleifAdapter().manifest().sourceKey).toBe("gleif-api");
    expect(new AgencyDirectoryFixture().manifest().sourceKey).toBe("agency-directory");
  });
});

describe("parseStaleAfterMinutes: operator states the threshold (B-D6)", () => {
  it("accepts positive integers inside the bounded window", () => {
    expect(parseStaleAfterMinutes(1)).toBe(1);
    expect(parseStaleAfterMinutes("120")).toBe(120);
    expect(parseStaleAfterMinutes(10_080)).toBe(10_080);
  });

  it("rejects absent, non-integer, and out-of-window values with 422", () => {
    for (const bad of [undefined, null, 0, -5, 1.5, 10_081, "abc", ""]) {
      expect(() => parseStaleAfterMinutes(bad)).toThrow(
        expect.objectContaining({ status: 422, code: "bad_stale_threshold" }),
      );
    }
  });
});